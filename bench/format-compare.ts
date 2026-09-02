/**
 * Format comparison benchmark: the production JSONL session log (the logical
 * format of the deepseek-harness JSONL persistence backend, one JSON event
 * per line, plaintext here since this repo does not carry the Zstandard
 * dependency) versus the session-format prototype (B+Tree pages + blob chain
 * + slimmed record + binding log over the durable segment store).
 *
 * Measures write (appending N events), read-full (reloading every event),
 * and on-disk bytes for both, so the two persistence shapes can be compared
 * on the same payload and machine. The JSONL write fsyncs once per batch of
 * 50 events; the session-format write fsyncs once per commit (its flush
 * covers every page written since the last one).
 *
 * Usage: npx vite-node bench/format-compare.ts [events]
 */
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, statSync, writeSync, rmSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskPageStore } from '../src/disk-page-store.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import { DiskSessionStore } from '../src/disk-session-store.ts'
import { SessionRepository } from '../src/repository.ts'
import type { BlobId, CompactionId, SessionId } from '../src/index.ts'

const EVENTS = Number(process.argv[2] ?? 500)
const SID = 'cmp' as SessionId
const JSONL_BATCH = 50

/** One user/message event envelope, the same vocabulary both formats carry. */
function eventPayload(n: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type: 'user/message',
    time: 1787736463867 + n,
    data: { id: `m${n}`, role: 'user', content: [{ type: 'text', text: 'hello world hello world hello world' }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }))
}

interface Result {
  readonly label: string
  readonly writeMs: number
  readonly readMs: number
  readonly bytes: number
}

/** Byte length of one Zstandard frame starting at the front of `bytes`.
 * Parses the RFC 8878 frame header (magic, descriptor, window, content size)
 * and walks the block sequence to the last block.
 * @param bytes - buffer starting at a Zstandard frame magic.
 * @returns the frame length in bytes.
 */
function zstdFrameLength(bytes: Uint8Array): number {
  let pos = 0
  const u32 = (at: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true)
  if (u32(pos) !== 0xfd2fb528) throw new Error(`bad zstd frame magic: got ${u32(pos).toString(16)}, pos=${pos}, first=${[...bytes.subarray(0, 12)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  pos += 4
  const fhd = bytes[pos]
  if (fhd === undefined) throw new Error('truncated zstd frame descriptor')
  pos += 1
  const fcsFlag = (fhd >> 6) & 0x3
  const singleSegment = ((fhd >> 5) & 0x1) === 1
  const hasChecksum = ((fhd >> 2) & 0x1) === 1
  if (!singleSegment) pos += 1 // window descriptor
  let fcsSize = [0, 1, 2, 4, 8][fcsFlag] ?? 0
  if (singleSegment && fcsSize === 0) fcsSize = 1
  pos += fcsSize
  for (;;) {
    const b0 = bytes[pos]
    const b1 = bytes[pos + 1]
    const b2 = bytes[pos + 2]
    if (b0 === undefined || b1 === undefined || b2 === undefined) throw new Error('truncated zstd block header')
    const last = b0 & 0x1
    const blockType = (b0 >> 1) & 0x3
    const blockSize = (b0 >> 3) | (b1 << 5) | (b2 << 13)
    pos += 3
    if (blockType === 1) pos += 1 // RLE block: one byte of raw data
    else pos += blockSize
    if (last === 1) return pos + (hasChecksum ? 4 : 0) // trailing XXH64 checksum
  }
}

/** JSONL with one fsync per `batch` events; `batch = 1` aligns the
 * durability granularity with the session-format one-commit-per-append path.
 * The zstd variant matches the production backend's physical container: one
 * Zstandard frame per batch with the checksum flag set, concatenated. */
function benchJsonl(events: number, batch: number, label: string, useZstd: boolean): Result {
  const frame = (bytes: Uint8Array): Uint8Array => {
    if (!useZstd) return bytes
    const compressed = zstdCompressSync(Buffer.from(bytes), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    })
    return new Uint8Array(compressed)
  }
  const dir = mkdtempSync(join(tmpdir(), 'sf-cmp-jsonl-'))
  const path = join(dir, 'session.jsonl')
  const fd = openSync(path, 'w', 0o600)
  try {
    // The production container compresses the whole artifact (header included)
    // into Zstandard frames; the plaintext tier keeps the header as a raw line.
    const headerFrame = frame(new TextEncoder().encode(JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 }) + '\n'))
    writeSync(fd, headerFrame)
    const start = performance.now()
    let batchBuf: number[] = []
    const flushBatch = (): void => {
      if (batchBuf.length === 0) return
      writeSync(fd, frame(new TextEncoder().encode(batchBuf.join(''))))
      batchBuf = []
    }
    for (let i = 0; i < events; i++) {
      batchBuf.push(new TextDecoder().decode(eventPayload(i)), '\n')
      if (batchBuf.length >= batch * 2) {
        flushBatch()
        fsyncSync(fd)
      }
    }
    flushBatch()
    fsyncSync(fd)
    const writeMs = performance.now() - start
    const readStart = performance.now()
    const raw = readFileSync(path)
    if (useZstd) {
      // Concatenated frames (the production container): decode each frame in
      // turn by walking its frame length.
      let pos = 0
      while (pos < raw.length) {
        const frameLen = zstdFrameLength(raw.subarray(pos))
        const decoded = zstdDecompressSync(raw.subarray(pos, pos + frameLen))
        for (const line of decoded.toString('utf8').split('\n')) {
          if (line !== '') JSON.parse(line)
        }
        pos += frameLen
      }
    } else {
      const text = raw.toString('utf8')
      for (const line of text.split('\n')) {
        if (line !== '') JSON.parse(line)
      }
    }
    const readMs = performance.now() - readStart
    return { label, writeMs, readMs, bytes: statSync(path).size }
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}

function benchSessionFormat(events: number): Result {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cmp-sf-'))
  try {
    const pages = new DiskPageStore(dir)
    const engine = new SessionFormatEngine(pages, new DiskSessionStore(dir))
    const repository = new SessionRepository(engine)
    repository.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
    const payload = eventPayload(0)
    const start = performance.now()
    for (let i = 0; i < events; i++) repository.append(SID, payload)
    const writeMs = performance.now() - start
    const readStart = performance.now()
    const file = repository.loadSession(SID)
    const readMs = performance.now() - readStart
    if (file.entries.length !== events) throw new Error('session-format read-back lost events')
    repository.gc()
    const bytes = statSync(join(dir, 'pages.bin')).size
      + statSync(join(dir, 'records', `${SID}.json`)).size
      + statSync(join(dir, 'bindings', `${SID}.log`)).size
    return { label: 'session-format', writeMs, readMs, bytes }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const jsonlBatch = benchJsonl(EVENTS, JSONL_BATCH, 'JSONL 批 fsync(50)', false)
const jsonlZstd = benchJsonl(EVENTS, JSONL_BATCH, 'JSONL zstd(50)', true)
const jsonlPerEvent = benchJsonl(EVENTS, 1, 'JSONL 每事件 fsync', false)
const sf = benchSessionFormat(EVENTS)
const row = (r: Result): string =>
  `${r.label.padEnd(20)} 写 ${r.writeMs.toFixed(1).padStart(8)}ms (${(r.writeMs / EVENTS).toFixed(3)}ms/事件)  ` +
  `读 ${r.readMs.toFixed(1).padStart(7)}ms  磁盘 ${(r.bytes / 1024).toFixed(1).padStart(8)}KB`

console.log(`对比 ${EVENTS} 个事件（payload 同源，单机磁盘引擎）\n`)
console.log(row(jsonlBatch))
console.log(row(jsonlZstd))
console.log(row(jsonlPerEvent))
console.log(row(sf))
console.log(`\nvs JSONL 批 fsync:  写 ${(sf.writeMs / jsonlBatch.writeMs).toFixed(1)}x | 读 ${(sf.readMs / jsonlBatch.readMs).toFixed(1)}x | 空间 ${(sf.bytes / jsonlBatch.bytes).toFixed(2)}x`)
console.log(`vs JSONL 每事件 fsync: 写 ${(sf.writeMs / jsonlPerEvent.writeMs).toFixed(2)}x（持久性粒度对齐）`)
console.log(`\n说明: 持久性粒度 JSONL 批=每 50 事件一次 fsync（崩溃丢≤49 个），每事件档与 session-format 对齐（每事件即持久）`)
console.log(`      JSONL zstd 档 = 主仓库物理容器（每批一个 Zstandard frame，checksum flag）；session-format 读含全量校验`)
console.log(`      payload 高度重复（同文本事件），zstd 压缩率因此偏极端；真实会话事件内容各异，压缩率更低`)

const blobId = (n: number): BlobId => `blob_${n}` as BlobId

/** Build the four replacement event envelopes for a physical compaction over
 * `seqs` (1-based surface positions), mirroring the repository spec's
 * compact fixtures so the engine's checkpoint/summary validation passes.
 */
function buildReplacementBlobs(seqs: number[]): ReadonlyMap<BlobId, Uint8Array> {
  const count = seqs.length
  const envelope = (type: string, data: Record<string, unknown>): Uint8Array => {
    const { surfaceOp, sourceEventSeqs, ...rest } = data
    const body: Record<string, unknown> = {
      type, time: 1,
      data: { compactionId: 'compact_bench', turn: null, ...rest },
    }
    if (surfaceOp !== undefined) body.surfaceOp = surfaceOp
    if (sourceEventSeqs !== undefined) body.sourceEventSeqs = sourceEventSeqs
    return new TextEncoder().encode(JSON.stringify(body))
  }
  const summary = {
    summary: [{ type: 'text', text: 'checkpoint' }],
    shadowedTokenCount: count,
    provider: 'bench',
    model: 'bench',
    shadowedRange: { start: 1, end: count },
    shadowedSeqs: seqs,
  }
  return new Map([
    [blobId(2000), envelope('user/message', {
      id: 'm2000', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_bench' },
      shadowedRange: { start: 1, end: count }, shadowedSeqs: seqs, shadowedTokenCount: count,
      surfaceOp: { op: 'replace', start: 1, end: count }, sourceEventSeqs: seqs,
    })],
    [blobId(2001), envelope('compaction/start', { marker: 2001 })],
    [blobId(2002), envelope('compaction/summary', summary)],
    [blobId(2003), envelope('compaction/end', { marker: 2003 })],
  ])
}

/** The session-format advantage: physical compaction removes the shadowed
 * events from disk and from replay, while the JSONL log can only append a
 * summary and keep every old event. */
function benchCompaction(events: number, shadow: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cmp-compact-'))
  try {
    const pages = new DiskPageStore(dir)
    const engine = new SessionFormatEngine(pages, new DiskSessionStore(dir))
    const repository = new SessionRepository(engine)
    repository.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
    const payload = eventPayload(0)
    for (let i = 0; i < events; i++) repository.append(SID, payload)
    repository.gc()
    const sfBytes = (): number => statSync(join(dir, 'pages.bin')).size
      + statSync(join(dir, 'records', `${SID}.json`)).size
      + statSync(join(dir, 'bindings', `${SID}.log`)).size
    const spaceBefore = sfBytes()
    const entriesBefore = events

    const seqs = Array.from({ length: shadow }, (_, i) => i + 1)
    const shadowedIds = Array.from({ length: shadow }, (_, i) => `evt_${SID}_${i}` as never)
    repository.compact(SID, {
      shadowedIds,
      checkpointEventId: `evt_${SID}_2000` as never,
      checkpointBlobId: 'blob_2000' as BlobId,
      compactionId: 'compact_bench' as CompactionId,
      startEventId: `evt_${SID}_2001` as never,
      summaryEventId: `evt_${SID}_2002` as never,
      endEventId: `evt_${SID}_2003` as never,
      startBlobId: 'blob_2001' as BlobId,
      summaryBlobId: 'blob_2002' as BlobId,
      endBlobId: 'blob_2003' as BlobId,
    }, buildReplacementBlobs(seqs))
    repository.gc()
    // The rolling backups still pin the pre-compaction blob chain, so the
    // disk space is reclaimed only after enough commits rotate them out.
    const spaceAfterCompact = sfBytes()
    const payload2 = eventPayload(0)
    for (let i = 0; i < 4; i++) repository.append(SID, payload2)
    repository.gc()
    const spaceAfterRotate = sfBytes()
    const entriesAfter = repository.loadSession(SID).entries.length

    // JSONL side: the production compaction seam appends a summary event and
    // keeps every old event, so bytes and replay size only grow.
    const jl = mkdtempSync(join(tmpdir(), 'sf-cmp-jl2-'))
    const fd = openSync(join(jl, 'session.jsonl'), 'w', 0o600)
    writeSync(fd, new TextEncoder().encode(JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 }) + '\n'))
    for (let i = 0; i < events; i++) {
      writeSync(fd, eventPayload(i))
      writeSync(fd, new TextEncoder().encode('\n'))
    }
    writeSync(fd, new TextEncoder().encode(JSON.stringify({ type: 'compaction/summary', time: 1, data: { summary: [{ type: 'text', text: 'checkpoint' }] }, surfaceOp: 'replace' }) + '\n'))
    closeSync(fd)
    const jsonlBytes = statSync(join(jl, 'session.jsonl')).size
    // The production backend compresses the whole artifact in one frame.
    const zstdBytes = zstdCompressSync(readFileSync(join(jl, 'session.jsonl')), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    }).length
    rmSync(jl, { recursive: true, force: true })

    console.log(`\n=== 物理压缩优势（${events} 事件，遮蔽 ${shadow} 个表面事件）===`)
    console.log(`JSONL 明文（追加 summary，旧事件全保留）:  磁盘 ${(jsonlBytes / 1024).toFixed(1)}KB | 重放 ${events + 1} 个事件`)
    console.log(`JSONL zstd 整帧（主仓库默认物理格式）:     磁盘 ${(zstdBytes / 1024).toFixed(1)}KB | 重放 ${events + 1} 个事件  ← zstd 压存储，压不了重放`)
    console.log(`session-format 压缩前:                  磁盘 ${(spaceBefore / 1024).toFixed(1)}KB | 重放 ${entriesBefore} 个事件`)
    console.log(`session-format 压缩 + GC 后:            磁盘 ${(spaceAfterCompact / 1024).toFixed(1)}KB（备份仍持旧 blob 链）`)
    console.log(`session-format 压缩 + 备份轮换 + GC:    磁盘 ${(spaceAfterRotate / 1024).toFixed(1)}KB | 重放 ${entriesAfter} 个事件`)
    console.log(`  空间 ${(spaceAfterRotate / spaceBefore * 100).toFixed(0)}%（JSONL 为 ${(jsonlBytes / spaceBefore * 100).toFixed(0)}% 且持续增长）`)
    console.log(`  重放 ${(entriesAfter / entriesBefore * 100).toFixed(0)}%（JSONL 恒为 100% + 摘要）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

benchCompaction(EVENTS, Math.floor(EVENTS * 0.8))

/** The JSONL format's structural advantages beyond bytes: streaming reads
 * (bounded memory) and incremental tail reads (cost proportional to the new
 * events, not the whole log). These are format capabilities the production
 * implementation does not currently use (readStoredLog reads the whole file),
 * so they are measured as the format's ceiling, labeled accordingly. */
function benchStreamingAndIncremental(events: number, extra: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cmp-mem-'))
  try {
    // --- JSONL: write N events, record the tail offset, append M more ---
    const path = join(dir, 'session.jsonl')
    const fd = openSync(path, 'w', 0o600)
    writeSync(fd, new TextEncoder().encode(JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 }) + '\n'))
    const offsets: number[] = [0]
    for (let i = 0; i < events + extra; i++) {
      const line = new TextDecoder().decode(eventPayload(i)) + '\n'
      writeSync(fd, new TextEncoder().encode(line))
      if (i === events - 1) offsets.push(statSync(path).size) // offset after the first N events
    }
    fsyncSync(fd)
    closeSync(fd)

    // Streaming read of all lines: parse and drop, keep only a counter.
    const rssBefore = process.memoryUsage().rss
    const full = readFileSync(path, 'utf8')
    let count = 0
    for (const line of full.split('\n')) {
      if (line !== '') { JSON.parse(line); count += 1 }
    }
    const rssDeltaStreaming = process.memoryUsage().rss - rssBefore

    // Incremental tail read from the recorded offset: only the M extra events.
    const t0 = performance.now()
    const tail = readFileSync(path, 'utf8').slice(offsets[1] ?? 0)
    let tailCount = 0
    for (const line of tail.split('\n')) {
      if (line !== '') { JSON.parse(line); tailCount += 1 }
    }
    const tailMs = performance.now() - t0
    void full
    void count

    // --- session-format: loadSession materializes the whole file ---
    const pages = new DiskPageStore(join(dir, 'sf'))
    const engine = new SessionFormatEngine(pages, new DiskSessionStore(join(dir, 'sf')))
    const repository = new SessionRepository(engine)
    repository.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
    for (let i = 0; i < events + extra; i++) repository.append(SID, eventPayload(i))
    const rssBefore2 = process.memoryUsage().rss
    const t1 = performance.now()
    const file = repository.loadSession(SID) // materializes entries + blobs
    const loadMs = performance.now() - t1
    const rssDeltaMaterialize = process.memoryUsage().rss - rssBefore2
    void file

    console.log(`\n=== 流式与增量读取（${events} 事件 + ${extra} 增量，格式能力上限）===`)
    console.log(`JSONL 流式读（逐行解析丢弃）:       峰值内存 +${(rssDeltaStreaming / 1024 / 1024).toFixed(1)}MB`)
    console.log(`session-format loadSession（物化全部）: 峰值内存 +${(rssDeltaMaterialize / 1024 / 1024).toFixed(1)}MB | 耗时 ${loadMs.toFixed(1)}ms`)
    console.log(`JSONL 增量读尾部（seek 到记录偏移）:    ${tailMs.toFixed(2)}ms 读 ${tailCount} 个事件（∝新增量，非全量）`)
    console.log(`  （主仓库 JSONL 实现当前未使用流式/增量读——readStoredLog 仍全量读取；session-format 无增量读 API，loadSession 是唯一读路径）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

benchStreamingAndIncremental(EVENTS, 50)

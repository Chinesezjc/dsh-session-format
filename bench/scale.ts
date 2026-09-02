/**
 * Scale benchmark: tens of thousands of records on in-memory engines, so the
 * asymptotic behavior is measurable in seconds (the disk engine's
 * one-fsync-per-commit makes tens of thousands of appends impractical).
 * Space is counted as logical bytes — the checksummed page containers for
 * session-format, the plaintext or Zstandard-compressed lines for JSONL —
 * without filesystem overhead. The disk-side comparison at smaller N lives in
 * format-compare.ts.
 *
 * Usage: npx vite-node bench/scale.ts [events]
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { SessionFormatEngine } from '../src/engine.ts'
import type { BlobId, CompactionId, SessionId } from '../src/index.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'

const EVENTS = Number(process.argv[2] ?? 30000)
const SID = 'scale' as SessionId

function eventPayload(n: number): Uint8Array {
  // Varied payloads (message text depends on n) so zstd compression is not
  // unrealistically high.
  return new TextEncoder().encode(JSON.stringify({
    type: 'user/message',
    time: 1787736463867 + n,
    data: { id: `m${n}`, role: 'user', content: [{ type: 'text', text: `message body number ${n} with some filler words repeated` }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }))
}

function jsonlBytes(events: number, useZstd: boolean): number {
  const lines: string[] = [JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 })]
  for (let i = 0; i < events; i++) lines.push(new TextDecoder().decode(eventPayload(i)))
  const plain = new TextEncoder().encode(lines.join('\n') + '\n')
  if (!useZstd) return plain.length
  return zstdCompressSync(Buffer.from(plain), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }).length
}

function sessionFormatSetup(events: number): { repository: SessionRepository; pages: PageStore } {
  const pages = new PageStore()
  const engine = new SessionFormatEngine(pages, new SessionStore())
  const repository = new SessionRepository(engine)
  repository.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
  const payload = eventPayload(0)
  const start = performance.now()
  for (let i = 0; i < events; i++) repository.append(SID, payload)
  const writeMs = performance.now() - start
  return { repository, pages }
}

function pageBytes(pages: PageStore): number {
  const backing = (pages as unknown as { pages: Map<string, Uint8Array> }).pages
  let total = 0
  for (const bytes of backing.values()) total += bytes.length
  return total
}

console.log(`scale benchmark: ${EVENTS} 事件（payload 各异），内存引擎、逻辑字节\n`)

// --- write ---
const startW = performance.now()
const plain = new TextEncoder().encode([JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 })].concat(
  Array.from({ length: EVENTS }, (_, i) => new TextDecoder().decode(eventPayload(i))),
).join('\n') + '\n')
const jsonlWriteMs = performance.now() - startW

const { repository, pages } = sessionFormatSetup(EVENTS)
console.log(`写 ${EVENTS} 事件: JSONL 明文 ${jsonlWriteMs.toFixed(0)}ms | session-format ${''}（见下）`)

// 重新计时 session-format 写（避免混合）
const p2 = new PageStore()
const e2 = new SessionFormatEngine(p2, new SessionStore())
const r2 = new SessionRepository(e2)
r2.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
const payload = eventPayload(0)
const t0 = performance.now()
for (let i = 0; i < EVENTS; i++) r2.append(SID, payload)
const sfWriteMs = performance.now() - t0

// --- space ---
r2.gc()
const sfSpace = pageBytes(p2)
const jsonlPlainSpace = jsonlBytes(EVENTS, false)
const jsonlZstdSpace = jsonlBytes(EVENTS, true)

// --- read ---
const t1 = performance.now()
const file = r2.loadSession(SID)
const sfReadMs = performance.now() - t1
if (file.entries.length !== EVENTS) throw new Error('lost events')
const t2 = performance.now()
const text = new TextDecoder().decode(plain)
let parsed = 0
for (const line of text.split('\n')) {
  if (line !== '') { JSON.parse(line); parsed += 1 }
}
const jsonlReadMs = performance.now() - t2
const zstd = zstdCompressSync(Buffer.from(plain), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const t3 = performance.now()
const decoded = zstdDecompressSync(zstd)
const text2 = decoded.toString('utf8')
let parsed2 = 0
for (const line of text2.split('\n')) {
  if (line !== '') { JSON.parse(line); parsed2 += 1 }
}
const jsonlZstdReadMs = performance.now() - t3

console.log(`\n=== 写 / 读 / 空间（${EVENTS} 事件）===`)
const kb = (b: number): string => `${(b / 1024).toFixed(0)}KB`
console.log(`写: JSONL ${jsonlWriteMs.toFixed(0)}ms | session-format ${sfWriteMs.toFixed(0)}ms (${(sfWriteMs / jsonlWriteMs).toFixed(1)}x)`)
console.log(`读全量: JSONL ${jsonlReadMs.toFixed(1)}ms | JSONL zstd ${jsonlZstdReadMs.toFixed(1)}ms | session-format ${sfReadMs.toFixed(1)}ms (${(sfReadMs / jsonlReadMs).toFixed(1)}x)`)
console.log(`空间(GC后): JSONL 明文 ${kb(jsonlPlainSpace)} | JSONL zstd ${kb(jsonlZstdSpace)} | session-format ${kb(sfSpace)} (${(sfSpace / jsonlZstdSpace).toFixed(1)}x vs zstd)`)

// --- compaction at scale ---
console.log(`\n=== 物理压缩（遮蔽 80% 表面事件）===`)
const shadow = Math.floor(EVENTS * 0.8)
const seqs = Array.from({ length: shadow }, (_, i) => i + 1)
const count = seqs.length
const envelope = (type: string, data: Record<string, unknown>): Uint8Array => {
  const { surfaceOp, sourceEventSeqs, ...rest } = data
  const body: Record<string, unknown> = { type, time: 1, data: { compactionId: 'compact_scale', turn: null, ...rest } }
  if (surfaceOp !== undefined) body.surfaceOp = surfaceOp
  if (sourceEventSeqs !== undefined) body.sourceEventSeqs = sourceEventSeqs
  return new TextEncoder().encode(JSON.stringify(body))
}
const summary = { summary: [{ type: 'text', text: 'checkpoint' }], shadowedTokenCount: count, provider: 'scale', model: 'scale', shadowedRange: { start: 1, end: count }, shadowedSeqs: seqs }
const blobId = (n: number): BlobId => `blob_${n}` as BlobId
const replacement = new Map([
  [blobId(EVENTS * 2), envelope('user/message', {
    id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_scale' },
    shadowedRange: { start: 1, end: count }, shadowedSeqs: seqs, shadowedTokenCount: count,
    surfaceOp: { op: 'replace', start: 1, end: count }, sourceEventSeqs: seqs,
  })],
  [blobId(EVENTS * 2 + 1), envelope('compaction/start', { marker: 1 })],
  [blobId(EVENTS * 2 + 2), envelope('compaction/summary', summary)],
  [blobId(EVENTS * 2 + 3), envelope('compaction/end', { marker: 1 })],
])
const shadowedIds = Array.from({ length: shadow }, (_, i) => `evt_${SID}_${i}` as never)
const spaceBefore = pageBytes(p2)
const entriesBefore = EVENTS
const tc = performance.now()
r2.compact(SID, {
  shadowedIds,
  checkpointEventId: `evt_${SID}_${EVENTS * 2}` as never,
  checkpointBlobId: blobId(EVENTS * 2),
  compactionId: 'compact_scale' as CompactionId,
  startEventId: `evt_${SID}_${EVENTS * 2 + 1}` as never,
  summaryEventId: `evt_${SID}_${EVENTS * 2 + 2}` as never,
  endEventId: `evt_${SID}_${EVENTS * 2 + 3}` as never,
  startBlobId: blobId(EVENTS * 2 + 1),
  summaryBlobId: blobId(EVENTS * 2 + 2),
  endBlobId: blobId(EVENTS * 2 + 3),
}, replacement)
const compactMs = performance.now() - tc
const payload2 = eventPayload(0)
for (let i = 0; i < 4; i++) r2.append(SID, payload2)
r2.gc()
const spaceAfter = pageBytes(p2)
const entriesAfter = r2.loadSession(SID).entries.length
const jsonlAfter = jsonlPlainSpace + jsonlBytes(1, false)

console.log(`compact 耗时: ${compactMs.toFixed(0)}ms`)
console.log(`JSONL（追加 summary）:       空间 ${kb(jsonlAfter)} | 重放 ${EVENTS + 1} 事件`)
console.log(`session-format 压缩前:       空间 ${kb(spaceBefore)} | 重放 ${entriesBefore} 事件`)
console.log(`session-format 压缩+轮换+GC: 空间 ${kb(spaceAfter)} (${(spaceAfter / spaceBefore * 100).toFixed(0)}%) | 重放 ${entriesAfter} (${(entriesAfter / entriesBefore * 100).toFixed(0)}%)`)

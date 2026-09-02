/**
 * Realistic-composition benchmark: a session whose events mirror the real
 * large logs — streamed chunk events (assistant/chunk, reasoning-chunks,
 * tool-call-chunks) dominate the byte count while a minority of surface
 * events (user/message, tool/call, tool/result) carry the conversation.
 * Compacts the first rounds (surface events plus their chunk closure) and
 * compares JSONL (plain and zstd) against session-format on space and replay.
 *
 * Usage: npx vite-node bench/realistic.ts [rounds] [roundsToCompact]
 */
import { constants, zstdCompressSync } from 'node:zlib'
import { SessionFormatEngine } from '../src/engine.ts'
import type { BlobId, CompactionId, SessionId } from '../src/index.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'

const ROUNDS = Number(process.argv[2] ?? 5000)
const TO_COMPACT = Number(process.argv[3] ?? Math.floor(ROUNDS * 0.4))
const SID = 'real' as SessionId
const CHUNKS_PER_ROUND = 4

/** One round: a surface user message plus streamed chunk closure, with
 * varied text so compression is realistic (not the repeated-payload case). */
function roundPayloads(n: number): { surface: Uint8Array; chunks: Uint8Array[] } {
  const surface = new TextEncoder().encode(JSON.stringify({
    type: 'user/message', time: 1787736463867 + n,
    data: { id: `m${n}`, role: 'user', content: [{ type: 'text', text: `user message number ${n}: asking about task ${n} in project ${n % 7}` }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }))
  const kinds = ['assistant/chunk', 'reasoning-chunks', 'tool-call-chunks'] as const
  const chunks: Uint8Array[] = []
  for (let c = 0; c < CHUNKS_PER_ROUND; c++) {
    const kind = kinds[c % kinds.length]!
    chunks.push(new TextEncoder().encode(JSON.stringify({
      type: kind, time: 1787736463867 + n + c,
      data: { id: `${kind}-${n}-${c}`, text: `streamed fragment ${n}.${c}: ${'tokens of model output for round '.repeat(3)}${n}${'x'.repeat((n + c) % 40)}`, turn: 1 },
    })))
  }
  return { surface, chunks }
}

function jsonlRepresentation(payloads: readonly { surface: Uint8Array; chunks: Uint8Array[] }[]): { plain: number; zstd: number } {
  const lines = [JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 })]
  for (const p of payloads) {
    lines.push(new TextDecoder().decode(p.surface))
    for (const chunk of p.chunks) lines.push(new TextDecoder().decode(chunk))
  }
  const plain = new TextEncoder().encode(lines.join('\n') + '\n')
  const zstd = zstdCompressSync(Buffer.from(plain), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }).length
  return { plain: plain.length, zstd }
}

function pageBytes(pages: PageStore): number {
  const backing = (pages as unknown as { pages: Map<string, Uint8Array> }).pages
  let total = 0
  for (const bytes of backing.values()) total += bytes.length
  return total
}

const payloads: { surface: Uint8Array; chunks: Uint8Array[] }[] = []
for (let n = 0; n < ROUNDS; n++) {
  const { surface, chunks } = roundPayloads(n)
  payloads.push({ surface, chunks })
}
const totalEvents = ROUNDS * (1 + CHUNKS_PER_ROUND)

// JSONL 空间
const jsonl = jsonlRepresentation(payloads)
console.log(`JSONL 明文空间: ${(jsonl.plain / 1024 / 1024).toFixed(2)}MB | zstd: ${(jsonl.zstd / 1024 / 1024).toFixed(2)}MB (${(jsonl.plain / jsonl.zstd).toFixed(1)}x)`)

// session-format
const pages = new PageStore()
const engine = new SessionFormatEngine(pages, new SessionStore())
const repository = new SessionRepository(engine)
repository.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
const t0 = performance.now()
for (const p of payloads) {
  repository.append(SID, p.surface)
  for (const chunk of p.chunks) repository.append(SID, chunk)
}
const writeMs = performance.now() - t0
repository.gc()
const spaceBefore = pageBytes(pages)
const entriesBefore = repository.loadSession(SID).entries.length
console.log(`\nsession-format 写: ${writeMs.toFixed(0)}ms | 空间(GC后): ${(spaceBefore / 1024 / 1024).toFixed(2)}MB | 重放: ${entriesBefore} 事件`)

// 表面 vs chunk 字节占比（payload 层面）
let surfaceBytes = 0
let chunkBytes = 0
for (const p of payloads) {
  surfaceBytes += p.surface.byteLength
  for (const c of p.chunks) chunkBytes += c.byteLength
}
console.log(`payload 构成: 表面 ${(surfaceBytes / 1024).toFixed(0)}KB (${(surfaceBytes / (surfaceBytes + chunkBytes) * 100).toFixed(0)}%) | chunk ${(chunkBytes / 1024).toFixed(0)}KB (${(chunkBytes / (surfaceBytes + chunkBytes) * 100).toFixed(0)}%)`)

// compact: 遮蔽前 TO_COMPACT 轮的表面事件。The current prototype removes
// exactly the explicitly named surface events; log-only chunk events between
// them survive (compaction.ts), so the chunk closure expansion of the Agent
// Note design is not implemented here — this measures what the prototype can
// actually reclaim on a chunk-heavy log. Surface events are identified by
// their envelope carrying a surfaceOp marker.
const loadedBefore = repository.loadSession(SID)
const surfaceIds = loadedBefore.entries
  .filter(entry => {
    const bytes = loadedBefore.blobs.get(entry.blobId)
    if (bytes === undefined) return false
    try {
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { surfaceOp?: unknown }
      return envelope.surfaceOp !== undefined
    } catch {
      return false
    }
  })
  .map(entry => entry.eventId)
const shadowedIds = surfaceIds.slice(0, TO_COMPACT)
const compactSeq = Array.from({ length: TO_COMPACT }, (_, i) => i + 1)
const count = compactSeq.length
const envelope = (type: string, data: Record<string, unknown>): Uint8Array => {
  const { surfaceOp, sourceEventSeqs, ...rest } = data
  const body: Record<string, unknown> = { type, time: 1, data: { compactionId: 'compact_real', turn: null, ...rest } }
  if (surfaceOp !== undefined) body.surfaceOp = surfaceOp
  if (sourceEventSeqs !== undefined) body.sourceEventSeqs = sourceEventSeqs
  return new TextEncoder().encode(JSON.stringify(body))
}
const summary = { summary: [{ type: 'text', text: 'checkpoint' }], shadowedTokenCount: count, provider: 'real', model: 'real', shadowedRange: { start: 1, end: count }, shadowedSeqs: compactSeq }
const blobId = (n: number): BlobId => `blob_${n}` as BlobId
const top = ROUNDS * (1 + CHUNKS_PER_ROUND) + 100
const replacement = new Map([
  [blobId(top), envelope('user/message', {
    id: 'cp', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_real' },
    shadowedRange: { start: 1, end: count }, shadowedSeqs: compactSeq, shadowedTokenCount: count,
    surfaceOp: { op: 'replace', start: 1, end: count }, sourceEventSeqs: compactSeq,
  })],
  [blobId(top + 1), envelope('compaction/start', { marker: 1 })],
  [blobId(top + 2), envelope('compaction/summary', summary)],
  [blobId(top + 3), envelope('compaction/end', { marker: 1 })],
])
const tc = performance.now()
repository.compact(SID, {
  shadowedIds: shadowedIds as never[],
  checkpointEventId: `evt_${SID}_${top}` as never,
  checkpointBlobId: blobId(top),
  compactionId: 'compact_real' as CompactionId,
  startEventId: `evt_${SID}_${top + 1}` as never,
  summaryEventId: `evt_${SID}_${top + 2}` as never,
  endEventId: `evt_${SID}_${top + 3}` as never,
  startBlobId: blobId(top + 1),
  summaryBlobId: blobId(top + 2),
  endBlobId: blobId(top + 3),
}, replacement)
const compactMs = performance.now() - tc
for (let i = 0; i < 4; i++) repository.append(SID, payloads[0]!.surface)
repository.gc()
const spaceAfter = pageBytes(pages)
const entriesAfter = repository.loadSession(SID).entries.length
const keptRounds = ROUNDS - TO_COMPACT

console.log(`\n=== 物理压缩（遮蔽前 ${TO_COMPACT} 轮：${shadowedIds.length} 个表面事件，chunk 闭包未实现故存活）===\n`)
console.log(`JSONL（追加 summary，全保留）:   空间 ${(jsonl.zstd / 1024 / 1024).toFixed(2)}MB(zstd) | 重放 ${totalEvents + 1} 事件`)
console.log(`session-format 压缩前:          空间 ${(spaceBefore / 1024 / 1024).toFixed(2)}MB | 重放 ${entriesBefore} 事件`)
console.log(`session-format 压缩+轮换+GC:    空间 ${(spaceAfter / 1024 / 1024).toFixed(2)}MB (${(spaceAfter / spaceBefore * 100).toFixed(0)}%) | 重放 ${entriesAfter} 事件`)
console.log(`  compact 耗时: ${compactMs.toFixed(0)}ms`)
console.log(`  重放构成: chunk ${(ROUNDS - TO_COMPACT) * CHUNKS_PER_ROUND} + 表面 ${entriesAfter - (ROUNDS - TO_COMPACT) * CHUNKS_PER_ROUND}（chunk 全存活，只少 ${TO_COMPACT} 表面 + 4 标记）`)

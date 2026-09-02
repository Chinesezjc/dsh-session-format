/**
 * Large-session stress: repeated rare operations (fork, compact, projection
 * checks, GC, read-back) over one big session, reporting failures, abnormal
 * timing, and result corruption. Run small first to validate the round
 * construction, then large: npx vite-node bench/stress.ts [events]
 */
import { SessionFormatEngine } from '../src/engine.ts'
import type { BlobId, CompactionId, SessionId } from '../src/index.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'

const EVENTS = Number(process.argv[2] ?? 20000)
const ROUNDS = Number(process.argv[3] ?? 12)
const SID = 'stress' as SessionId
const mk = (n: number): Uint8Array => new TextEncoder().encode(JSON.stringify({
  type: 'user/message', time: 1787736463867 + n,
  data: { id: `m${n}`, role: 'user', content: [{ type: 'text', text: `stress message ${n}` }], source: { kind: 'user' } },
  surfaceOp: 'append',
}))

const blobId = (n: number): BlobId => `blob_${n}` as BlobId
let replacementBase = EVENTS + 10000

/** Four replacement envelopes for one compaction over shadowed surface seqs. */
function replacementBlobs(seqs: number[], compactionId: string): ReadonlyMap<BlobId, Uint8Array> {
  const count = seqs.length
  const envelope = (type: string, data: Record<string, unknown>): Uint8Array => {
    const { surfaceOp, sourceEventSeqs, ...rest } = data
    const body: Record<string, unknown> = { type, time: 1, data: { compactionId, turn: null, ...rest } }
    if (surfaceOp !== undefined) body.surfaceOp = surfaceOp
    if (sourceEventSeqs !== undefined) body.sourceEventSeqs = sourceEventSeqs
    return new TextEncoder().encode(JSON.stringify(body))
  }
  const summary = { summary: [{ type: 'text', text: 'checkpoint' }], shadowedTokenCount: count, provider: 'stress', model: 'stress', shadowedRange: { start: seqs[0]!, end: seqs[count - 1]! }, shadowedSeqs: seqs }
  const b = replacementBase
  return new Map([
    [blobId(b), envelope('user/message', {
      id: 'cp', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId },
      shadowedRange: { start: seqs[0]!, end: seqs[count - 1]! }, shadowedSeqs: seqs, shadowedTokenCount: count,
      surfaceOp: { op: 'replace', start: seqs[0]!, end: seqs[count - 1]! }, sourceEventSeqs: seqs,
    })],
    [blobId(b + 1), envelope('compaction/start', { marker: 1 })],
    [blobId(b + 2), envelope('compaction/summary', summary)],
    [blobId(b + 3), envelope('compaction/end', { marker: 1 })],
  ])
}

interface OpResult { op: string; ok: boolean; ms: number; detail?: string }

const pages = new PageStore()
const engine = new SessionFormatEngine(pages, new SessionStore())
const repo = new SessionRepository(engine)
repo.createSession({ session: { sessionId: SID, formatVersion: 1, nextEventCounter: 0 }, entries: [], blobs: new Map(), references: [], compacted: [] })
console.log(`构造 ${EVENTS} 事件...`)
const t0 = performance.now()
for (let i = 0; i < EVENTS; i += 1000) {
  const batch: Uint8Array[] = []
  for (let j = 0; j < 1000 && i + j < EVENTS; j++) batch.push(mk(i + j))
  repo.appendBatch(SID, batch)
}
console.log(`构造完成: ${((performance.now() - t0) / 1000).toFixed(1)}s, ${pages.size} 页`)

const results: OpResult[] = []
let forks = 0
let compactRounds = 0
let failures = 0
let checkpointIds: string[] = [] // live compaction checkpoints (surfaces to avoid)

for (let round = 0; round < ROUNDS; round++) {
  const file = repo.loadSession(SID)
  const total = file.entries.length
  // Exclude every earlier transaction's markers (start/summary/end/checkpoint):
  // shadowing part of a bracket is rejected, so only plain surfaces may be cut.
  const checkpointSet = new Set<string>(checkpointIds)
  for (const summary of file.compacted) {
    checkpointSet.add(summary.markerEventIds.startEventId)
    checkpointSet.add(summary.markerEventIds.summaryEventId)
    checkpointSet.add(summary.markerEventIds.endEventId)
    checkpointSet.add(summary.checkpointEventId)
  }

  // ---- fork at the ~2/3 point of the live range (never a shadowed id) ----
  try {
    const forkId = `sess_fork_${round}` as SessionId
    const mid = file.entries[Math.floor(total * 0.6)]
    if (mid === undefined || checkpointSet.has(mid.eventId)) throw new Error('no fork point')
    const tf = performance.now()
    const child = repo.fork(SID, mid.eventId, forkId)
    const forkMs = performance.now() - tf
    const childFile = repo.loadSession(forkId)
    const expected = file.entries.findIndex(e => e.eventId === mid.eventId) + 1
    if (childFile.entries.length !== expected) {
      throw new Error(`fork child ${childFile.entries.length} != ${expected}`)
    }
    if (childFile.session.seedBoundaryId !== mid.eventId) throw new Error('fork seed boundary wrong')
    forks += 1
    results.push({ op: `fork#${round}`, ok: true, ms: forkMs })
  } catch (error) {
    failures += 1
    results.push({ op: `fork#${round}`, ok: false, ms: 0, detail: (error as Error).message })
  }

  // ---- compact the oldest live non-checkpoint surfaces (keep ~1/3) ----
  try {
    const keep = Math.floor(total * 0.85)
    const shadowable = file.entries.filter(e => !checkpointSet.has(e.eventId))
    const shadowed = shadowable.slice(0, total - keep)
    if (shadowed.length < 100) throw new Error('not enough shadowable surfaces')
    // Surface lineage positions of the shadowed set (1-based): markers are not
    // surfaces, so only non-marker entries occupy lineage positions.
    const surfaceRanks: number[] = []
    let rank = 0
    for (const entry of shadowable) {
      rank += 1
      if (shadowed.some(s => s.eventId === entry.eventId)) surfaceRanks.push(rank)
    }
    if (surfaceRanks.length === 0) throw new Error('no shadowed surface ranks')
    const shadowedIds = shadowed.map(s => s.eventId as never)
    const compactionId = `compact_stress_${compactRounds}`
    replacementBase += 1000
    const base = replacementBase
    const tc = performance.now()
    repo.compact(SID, {
      shadowedIds,
      checkpointEventId: `evt_${SID}_${base}` as never,
      checkpointBlobId: blobId(base),
      compactionId: compactionId as CompactionId,
      startEventId: `evt_${SID}_${base + 1}` as never,
      summaryEventId: `evt_${SID}_${base + 2}` as never,
      endEventId: `evt_${SID}_${base + 3}` as never,
      startBlobId: blobId(base + 1),
      summaryBlobId: blobId(base + 2),
      endBlobId: blobId(base + 3),
    }, replacementBlobs(surfaceRanks, compactionId))
    const compactMs = performance.now() - tc
    compactRounds += 1
    checkpointIds.push(`evt_${SID}_${base}`)
    results.push({ op: `compact#${compactRounds}`, ok: true, ms: compactMs })
  } catch (error) {
    failures += 1
    results.push({ op: `compact#${round}`, ok: false, ms: 0, detail: (error as Error).message })
  }

  // ---- projection stale check over the current tree ----
  try {
    const current = repo.loadSession(SID)
    const tp = performance.now()
    const summary = current.compacted[current.compacted.length - 1]
    const stale = summary === undefined ? false : repo.projectionNeedsRebuild(SID, { value: 1, watermarkEventId: summary.checkpointEventId }, summary)
    results.push({ op: `projection#${round}`, ok: true, ms: performance.now() - tp, detail: stale ? 'stale' : 'ok' })
  } catch (error) {
    failures += 1
    results.push({ op: `projection#${round}`, ok: false, ms: 0, detail: (error as Error).message })
  }

  // ---- read-back consistency ----
  try {
    const current = repo.loadSession(SID)
    for (let i = 1; i < current.entries.length; i++) {
      if (current.entries[i]!.order <= current.entries[i - 1]!.order) throw new Error('order not monotonic')
    }
    results.push({ op: `readback#${round}`, ok: true, ms: 0 })
  } catch (error) {
    failures += 1
    results.push({ op: `readback#${round}`, ok: false, ms: 0, detail: (error as Error).message })
  }

  // ---- gc ----
  try {
    const tg = performance.now()
    repo.gc()
    results.push({ op: `gc#${round}`, ok: true, ms: performance.now() - tg })
  } catch (error) {
    failures += 1
    results.push({ op: `gc#${round}`, ok: false, ms: 0, detail: (error as Error).message })
  }
}

const final = repo.loadSession(SID)
console.log(`\n${ROUNDS} 轮完成: fork ${forks} | compact ${compactRounds} | 失败 ${failures}/${results.length}`)
console.log(`最终会话: ${final.entries.length} 事件 | 页面 ${pages.size}`)
const byOp = new Map<string, number[]>()
for (const r of results) {
  if (r.ms > 0) {
    const list = byOp.get(r.op.replace(/#\d+$/, '')) ?? []
    list.push(r.ms)
    byOp.set(r.op.replace(/#\d+$/, ''), list)
  }
}
console.log('\n各操作耗时（ms，min/中位/max）:')
for (const [op, list] of byOp) {
  const sorted = [...list].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]!
  console.log(`  ${op.padEnd(16)} n=${String(list.length).padStart(3)}  min=${sorted[0]!.toFixed(1).padStart(8)}  med=${med.toFixed(1).padStart(8)}  max=${sorted[sorted.length - 1]!.toFixed(1).padStart(8)}`)
}
if (failures > 0) {
  console.log('\n失败明细:')
  for (const r of results) {
    if (!r.ok) console.log(`  ${r.op}: ${r.detail}`)
  }
}

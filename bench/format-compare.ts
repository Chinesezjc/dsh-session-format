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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskPageStore } from '../src/disk-page-store.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import { DiskSessionStore } from '../src/disk-session-store.ts'
import { SessionRepository } from '../src/repository.ts'
import type { SessionId } from '../src/index.ts'

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

/** Plaintext JSONL with one fsync per `batch` events; `batch = 1` aligns the
 * durability granularity with the session-format one-commit-per-append path. */
function benchJsonl(events: number, batch: number, label: string): Result {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cmp-jsonl-'))
  const path = join(dir, 'session.jsonl')
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, new TextEncoder().encode(JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 })))
    writeSync(fd, new TextEncoder().encode('\n'))
    const start = performance.now()
    for (let i = 0; i < events; i++) {
      writeSync(fd, eventPayload(i))
      writeSync(fd, new TextEncoder().encode('\n'))
      if (i % batch === batch - 1) fsyncSync(fd)
    }
    fsyncSync(fd)
    const writeMs = performance.now() - start
    const readStart = performance.now()
    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split('\n')) {
      if (line !== '') JSON.parse(line)
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

const jsonlBatch = benchJsonl(EVENTS, JSONL_BATCH, 'JSONL 批 fsync(50)')
const jsonlPerEvent = benchJsonl(EVENTS, 1, 'JSONL 每事件 fsync')
const sf = benchSessionFormat(EVENTS)
const row = (r: Result): string =>
  `${r.label.padEnd(20)} 写 ${r.writeMs.toFixed(1).padStart(8)}ms (${(r.writeMs / EVENTS).toFixed(3)}ms/事件)  ` +
  `读 ${r.readMs.toFixed(1).padStart(7)}ms  磁盘 ${(r.bytes / 1024).toFixed(1).padStart(8)}KB`

console.log(`对比 ${EVENTS} 个事件（payload 同源，单机磁盘引擎）\n`)
console.log(row(jsonlBatch))
console.log(row(jsonlPerEvent))
console.log(row(sf))
console.log(`\nvs JSONL 批 fsync:  写 ${(sf.writeMs / jsonlBatch.writeMs).toFixed(1)}x | 读 ${(sf.readMs / jsonlBatch.readMs).toFixed(1)}x | 空间 ${(sf.bytes / jsonlBatch.bytes).toFixed(2)}x`)
console.log(`vs JSONL 每事件 fsync: 写 ${(sf.writeMs / jsonlPerEvent.writeMs).toFixed(2)}x（持久性粒度对齐）`)
console.log(`\n说明: 持久性粒度 JSONL 批=每 50 事件一次 fsync（崩溃丢≤49 个），每事件档与 session-format 对齐（每事件即持久）`)
console.log(`      session-format 读含全量校验（validateSessionFile + serialize/deserialize 往返）；空间未含 JSONL 的 zstd 压缩（主仓库默认）`)

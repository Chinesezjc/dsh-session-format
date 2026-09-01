/**
 * Append-throughput benchmark: measures `SessionRepository.append` over a
 * growing session on the in-memory and disk-backed engines. Run before and
 * after a change to quantify the per-append cost. The id scans and the
 * per-commit backup blob-map re-reads are O(1) on the append path; the whole-
 * snapshot rewrite (multi-page tree, blob-map page, validation round-trip)
 * dominates and grows with the session, so the per-append time is expected to
 * grow linearly with event count.
 * Usage: npx vite-node bench/append-throughput.ts [count]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskPageStore } from '../src/disk-page-store.ts'
import { DiskSessionStore } from '../src/disk-session-store.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import type { BlobId, SessionId } from '../src/index.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'

const count = Number(process.argv[2] ?? 300)
const SESSION = 'bench_sess' as SessionId
const payload = new TextEncoder().encode(JSON.stringify({
  type: 'user/message',
  time: 1,
  data: { text: 'benchmark' },
  surfaceOp: 'append',
}))

function bench(label: string, engine: SessionFormatEngine, count: number): void {
  const repository = new SessionRepository(engine)
  repository.createSession({
    session: { sessionId: SESSION, formatVersion: 1, nextEventCounter: 0 },
    entries: [],
    blobs: new Map<BlobId, Uint8Array>(),
    references: [],
    compacted: [],
  })
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    repository.append(SESSION, payload)
  }
  const elapsed = performance.now() - start
  const events = repository.loadSession(SESSION).entries.length
  console.log(`${label}: ${count} appends in ${elapsed.toFixed(1)}ms (${(elapsed / count).toFixed(3)} ms/append, ${events} events)`)
}

bench('memory', new SessionFormatEngine(new PageStore(), new SessionStore()), count)

const root = mkdtempSync(join(tmpdir(), 'sf-bench-'))
try {
  bench('disk  ', new SessionFormatEngine(
    new DiskPageStore(join(root, 'pages')),
    new DiskSessionStore(join(root, 'records')),
  ), Math.min(count, 100))
} finally {
  rmSync(root, { recursive: true, force: true })
}

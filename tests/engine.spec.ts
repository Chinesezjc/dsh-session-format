import { describe, expect, it } from 'vitest'
import { fromEntries, SessionTree } from '../src/btree.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import type { SessionFile } from '../src/file.ts'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { BlobId, CompactionId, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from '../src/index.ts'
import { saveBlobMap } from '../src/metadata.ts'
import { saveMultiPageTree } from '../src/multi-page.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionStore } from '../src/store.ts'

function sessionId(): SessionId {
  return 'sess_engine' as SessionId
}

function eventId(n: number): EventId {
  return `evt_sess_engine_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

/** Shadowed-set size each summary blob must describe: only surface events
 * count, so the monotonicity second compact (markers 100-103) describes just
 * the checkpoint surface event. */
function summarySeqCount(n: number): number {
  if (n === 102) return 3
  if (n === 202) return 2
  return 1
}

function replacementEnvelope(n: number, type: string, compactionId: string): Uint8Array {
  const data = n === 102 || n === 202 || n === 302
    ? {
      summary: [],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
      compactionId,
      // The summary event's seq facts must describe exactly the shadowed
      // set: 3 for the first compact, 2 for the accumulated range, 4 for
      // the monotonicity second compact.
      shadowedRange: { start: 1, end: summarySeqCount(n) },
      shadowedSeqs: Array.from({ length: summarySeqCount(n) }, (_, index) => index + 1),
      // Start/end markers must share one turn; the summary marker only needs
      // a turn field for the envelope check.
      turn: null,
    }
    : { marker: n, compactionId, turn: null }
  const envelope = n === 100 || n === 200 || n === 300
    ? {
      // The compaction invariant pins the checkpoint type to user/message.
      type: 'user/message',
      time: n,
      data: {
        id: `m${n}`,
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId },
        // The checkpoint replace range must match the paired summary blob's
        // shadowedRange (base compaction.ts enforces the equality): the
        // summary sits at n+2 (102/202/302), so derive the count from it.
        shadowedRange: { start: 1, end: summarySeqCount(n + 2) },
        shadowedSeqs: Array.from({ length: summarySeqCount(n + 2) }, (_, index) => index + 1),
        shadowedTokenCount: 0,
      },
      surfaceOp: { op: 'replace', start: 1, end: summarySeqCount(n + 2) },
      // assertProvenance requires the checkpoint to cite every shadowed
      // surface node; the summary's shadowedSeqs are 1..count.
      sourceEventSeqs: Array.from({ length: summarySeqCount(n + 2) }, (_, index) => index + 1),
    }
    : { type, time: n, data }
  return new TextEncoder().encode(JSON.stringify(envelope))
}
function eventEnvelope(n: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type: 'user/message',
    time: n,
    data: { marker: n },
    surfaceOp: 'append',
  }))
}

function makeFile(eventCount = 8): SessionFile {
  let tree = SessionTree.empty()
  const blobs = new Map<BlobId, Uint8Array>()
  for (let i = 0; i < eventCount; i++) {
    const id = eventId(i)
    const blob = blobId(i)
    tree = tree.append(id, blob)
    blobs.set(blob, eventEnvelope(i))
  }
  // Compaction requires the four replacement blobs to already exist in the
  // file as full event envelopes, unreferenced by existing events. The
  // checkpoint envelope is the caller's summarization event; the other three
  // carry the fixed audit types.
  blobs.set(blobId(100), replacementEnvelope(100, 'user/message', 'compact_1'))
  blobs.set(blobId(101), replacementEnvelope(101, 'compaction/start', 'compact_1'))
  blobs.set(blobId(102), replacementEnvelope(102, 'compaction/summary', 'compact_1'))
  blobs.set(blobId(103), replacementEnvelope(103, 'compaction/end', 'compact_1'))
  const session: StoredSessionRecord = {
    sessionId: sessionId(),
    formatVersion: 1,
    rootPage: 'page_placeholder' as PageId,
    revision: 'rev-0' as SessionRevision,
    // Above every event suffix minted by makeFile (evt_<n> for n < eventCount).
    nextEventCounter: 100,

    backups: [],
  }
  return { session, entries: tree.entries(), blobs, references: [], compacted: [] }
}

function compactionInput(nextRevision = 'rev-1'): Parameters<SessionFormatEngine['compact']>[1] {
  return {
    shadowedIds: [eventId(2), eventId(3), eventId(4)],
    checkpointEventId: eventId(100),
    checkpointBlobId: blobId(100),
    compactionId: 'compact_1' as CompactionId,
    startEventId: eventId(101),
    summaryEventId: eventId(102),
    endEventId: eventId(103),
    nextEventCounter: 200,
    startBlobId: blobId(101),
    summaryBlobId: blobId(102),
    endBlobId: blobId(103),
    nextRevision: nextRevision as SessionRevision,
  }
}

/** Attach a fresh set of unreferenced replacement blobs to a loaded file so a
 * second compaction can satisfy the pre-written-blob contract. */
function withReplacementBlobs(file: SessionFile, ids: readonly number[]): SessionFile {
  const blobs = new Map(file.blobs)
  for (const n of ids) {
    const type = n % 10 === 2 ? 'compaction/summary' : n % 10 === 1 ? 'compaction/start' : n % 10 === 3 ? 'compaction/end' : 'user/message'
    blobs.set(blobId(n), replacementEnvelope(n, type, 'compact_2'))
  }
  return { ...file, blobs }
}

describe('SessionFormatEngine', () => {
  it('saves, loads, compacts with CAS, forks, and garbage collects', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const saved = engine.saveSession(makeFile())
    expect(saved.revision).toBe('rev-0')

    const summary = engine.compact(sessionId(), compactionInput())
    expect(summary).toBeDefined()
    const compacted = engine.loadSession(sessionId())
    expect(compacted.entries).toHaveLength(9)
    expect(compacted.entries[2]?.eventId).toBe(eventId(101))

    // Fork at a surface event, not at a compaction marker: the marker group
    // must be inherited whole or not at all.
    const child = engine.fork(sessionId(), eventId(5), 'sess_child' as SessionId)
    expect(child.sessionId).toBe('sess_child')
    expect(child.nextEventCounter).toBe(engine.loadSession(sessionId()).session.nextEventCounter)
    expect(engine.loadSession('sess_child' as SessionId).entries).toHaveLength(7)

    const removed = engine.gc()
    expect(removed).toBeGreaterThanOrEqual(0)
    // Sessions remain loadable after GC: the record's metadata pages and the
    // multi-page tree children are retained.
    expect(engine.loadSession(sessionId()).entries).toHaveLength(9)
    expect(engine.loadSession('sess_child' as SessionId).entries).toHaveLength(7)
  })

  it('throws when loading an unknown session', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    expect(() => engine.loadSession('sess_unknown' as SessionId)).toThrow(/session sess_unknown not found/)
  })

  it('loads an empty session record without blob map, reference, or compaction pages', () => {
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    const rootPage = saveMultiPageTree(pages, fromEntries([]))
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 0,
      backups: [],
    })
    const loaded = engine.loadSession(sessionId())
    expect(loaded.entries).toEqual([])
    expect(loaded.blobs.size).toBe(0)
    expect(loaded.references).toEqual([])
    expect(loaded.compacted).toEqual([])
  })

  it('rejects loading a record whose entries reference missing blobs', () => {
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    let tree = SessionTree.empty()
    for (let i = 0; i < 3; i++) tree = tree.append(eventId(i), blobId(i))
    const rootPage = saveMultiPageTree(pages, fromEntries(tree.entries()))
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 10,
      backups: [],
    })
    expect(() => engine.loadSession(sessionId())).toThrow(/references missing blob/)
  })

  it('persists compaction summaries across reloads', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    expect(engine.compact(sessionId(), compactionInput())).toBeDefined()
    const loaded = engine.loadSession(sessionId())
    expect(loaded.compacted).toHaveLength(1)
    expect(loaded.compacted[0]?.compactionId).toBe('compact_1' as CompactionId)
    expect(loaded.compacted[0]?.shadowedIds).toEqual([eventId(2), eventId(3), eventId(4)])
  })

  it('accumulates one compaction summary per committed compact', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    const first = compactionInput()
    expect(engine.compact(sessionId(), first)).toBeDefined()
    const second: Parameters<SessionFormatEngine['compact']>[1] = {
      ...first,
      shadowedIds: [eventId(6), eventId(7)],
      compactionId: 'compact_2' as CompactionId,
      nextEventCounter: 300,
      checkpointEventId: eventId(200),
      checkpointBlobId: blobId(200),
      startEventId: eventId(201),
      summaryEventId: eventId(202),
      endEventId: eventId(203),
      startBlobId: blobId(201),
      summaryBlobId: blobId(202),
      endBlobId: blobId(203),
      nextRevision: 'rev-3' as SessionRevision,
    }
    const withBlobs = withReplacementBlobs(engine.loadSession(sessionId()), [200, 201, 202, 203])
    engine.saveSession({ ...withBlobs, session: { ...withBlobs.session, revision: 'rev-2' as SessionRevision } }, 'rev-1' as SessionRevision)
    expect(engine.compact(sessionId(), second)).toBeDefined()
    expect(engine.loadSession(sessionId()).compacted).toHaveLength(2)
  })

  it('bumps the revision on each committed compact', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    expect(engine.compact(sessionId(), compactionInput())).toBeDefined()
    expect(engine.loadSession(sessionId()).session.revision).toBe('rev-1')
  })

  it('keeps metadata and tree pages after garbage collection', () => {
    const pages = new PageStore()
    const orphan = pages.writePage(new TextEncoder().encode('orphan'))
    const engine = new SessionFormatEngine(pages, new SessionStore())
    engine.saveSession(makeFile())
    expect(engine.gc()).toBe(1)
    expect(pages.has(orphan)).toBe(false)
    const loaded = engine.loadSession(sessionId())
    expect(loaded.entries).toHaveLength(8)
    // 8 event blobs + the 4 pre-supplied replacement blobs
    expect(loaded.blobs.size).toBe(12)
    expect(loaded.references).toEqual([])
  })

  it('round-trips a large session through multi-page trees', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(20))
    const loaded = engine.loadSession(sessionId())
    expect(loaded.entries).toHaveLength(20)
    expect(loaded.entries[19]?.eventId).toBe(eventId(19))
  })

  it('round-trips blobs and references', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const withReferences: SessionFile = {
      ...file,
      references: [{ fromEventId: eventId(3), refName: 'sourceEventIds', toEventIds: [eventId(1)] }],
    }
    engine.saveSession(withReferences)
    const loaded = engine.loadSession(sessionId())
    expect(Array.from(loaded.blobs.get(blobId(2))!)).toEqual(Array.from(eventEnvelope(2)))
    expect(loaded.references).toEqual([{ fromEventId: eventId(3), refName: 'sourceEventIds', toEventIds: [eventId(1)] }])
  })

  it('rejects a fork that reuses the parent id or an existing session', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    expect(() => engine.fork(sessionId(), eventId(1), sessionId())).toThrow(/fork requires a new session id/)
    expect(() => engine.fork(sessionId(), eventId(1), 'sess_child' as SessionId)).not.toThrow()
    expect(() => engine.fork(sessionId(), eventId(1), 'sess_child' as SessionId)).toThrow(/session sess_child already exists/)
  })

  it('rejects registering a session with a non-finite or ceiling revision', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    expect(() => engine.saveSession({ ...makeFile(), session: { ...makeFile().session, revision: 'rev-Infinity' as SessionRevision } }))
      .toThrow(/safe-integer rev-<n> token/)
    expect(() => engine.saveSession({ ...makeFile(), session: { ...makeFile().session, revision: 'rev-9007199254740991' as SessionRevision } }))
      .toThrow(/advanceable/)
    // One past the safe-integer range is equally rejected: the token parses
    // digits but the value is not a safe integer.
    expect(() => engine.saveSession({ ...makeFile(), session: { ...makeFile().session, revision: 'rev-9007199254740993' as SessionRevision } }))
      .toThrow(/safe-integer rev-<n> token/)
  })

  it('accepts a fork child whose events carry the parent prefix with a fresh counter', () => {
    // The EventId counter is per-session: a child inherits parent-prefixed
    // events, so its own nextEventCounter must not count them. The high-water
    // check must filter by the session's own namespace, mirroring the archive
    // boundary (file.ts), or a legitimate fork child at counter 0 would be
    // rejected.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    const child = engine.fork(sessionId(), eventId(1), 'sess_child' as SessionId)
    expect(child.sessionId).toBe('sess_child')
    expect(child.nextEventCounter).toBe(100)
    const loaded = engine.loadSession('sess_child' as SessionId)
    // The child hosts the inherited parent-prefixed events (evt_sess_engine_*)
    // alongside its own namespace; loading must succeed with the inherited
    // counter.
    expect(loaded.entries.length).toBeGreaterThan(0)
  })

  it('accepts a child file at counter 0 hosting only parent-prefixed events', () => {
    // The archive boundary (file.ts) accepts a session whose own namespace is
    // empty even when it hosts inherited evt_<parent>_* entries; the engine's
    // high-water check must agree, or such a file could not be saved.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    let tree = SessionTree.empty()
    tree = tree.append('evt_sess_parent_5' as EventId, blobId(5))
    const childFile: SessionFile = {
      session: {
        sessionId: 'sess_child' as SessionId,
        formatVersion: 1,
        rootPage: 'page_placeholder' as PageId,
        revision: 'rev-0' as SessionRevision,
        nextEventCounter: 0,
        backups: [],
      },
      entries: tree.entries(),
      blobs: new Map([[blobId(5), eventEnvelope(5)]]),
      references: [],
      compacted: [],
    }
    expect(engine.saveSession(childFile).sessionId).toBe('sess_child')
    expect(engine.loadSession('sess_child' as SessionId).entries).toHaveLength(1)

  })

  it('rejects a saveSession that would overwrite an existing session without a revision', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    expect(() => engine.saveSession(makeFile())).toThrow(/already exists; pass its revision to update via CAS/)
  })

  it('rejects a commit that regresses the persisted event counter', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    engine.saveSession({ ...makeFile(), session: { ...makeFile().session, revision: 'rev-1' as SessionRevision, nextEventCounter: 200 } }, 'rev-0' as SessionRevision)
    expect(() => engine.commitSession(
      { ...makeFile(), entries: [], session: { ...makeFile().session, revision: 'rev-2' as SessionRevision, nextEventCounter: 5 } },
      'rev-1' as SessionRevision,
    )).toThrow(/regresses the stored counter/)
  })

  it('treats a stale revision with a lower counter as a CAS miss', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    engine.saveSession({ ...makeFile(), session: { ...makeFile().session, revision: 'rev-1' as SessionRevision, nextEventCounter: 200 } }, 'rev-0' as SessionRevision)
    // The snapshot derives from rev-0 but the stored record is rev-1 with a
    // higher counter; the commit is a CAS miss and must return undefined
    // instead of throwing a counter regression error, so the caller can
    // reload and retry.
    expect(engine.commitSession(
      { ...makeFile(), entries: [], session: { ...makeFile().session, revision: 'rev-2' as SessionRevision, nextEventCounter: 5 } },
      'rev-0' as SessionRevision,
    )).toBeUndefined()
  })

  it('treats a stale writer minting a colliding blob id with different bytes as a CAS miss', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(1))
    const base = engine.loadSession(sessionId())
    // Two writers derive from rev-0 and mint the same next blob id (blob_1)
    // with different payloads; the first commits, so the second is stale. Its
    // different bytes under the colliding id must surface as a CAS miss
    // (undefined), not as an immutability error, so it can reload and retry.
    const first = {
      ...base,
      session: { ...base.session, revision: 'rev-1' as SessionRevision, nextEventCounter: 101 },
      blobs: new Map(base.blobs).set(blobId(1), new TextEncoder().encode('first')),
    }
    const second = {
      ...base,
      session: { ...base.session, revision: 'rev-1' as SessionRevision, nextEventCounter: 101 },
      blobs: new Map(base.blobs).set(blobId(1), new TextEncoder().encode('second')),
    }
    expect(engine.commitSession(first, 'rev-0' as SessionRevision)).toBeDefined()
    expect(engine.commitSession(second, 'rev-0' as SessionRevision)).toBeUndefined()
  })

  it('rejects a direct commitSession that rewrites an existing blob', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const tampered = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    // The immutability check lives at the single commit point, so a direct
    // commitSession caller cannot bypass the saveSession-only check.
    expect(() => engine.commitSession(tampered, 'rev-0' as SessionRevision))
      .toThrow(/immutable/)
  })

  it('returns undefined when committing to an unknown session', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = { ...makeFile(), session: { ...makeFile().session, revision: 'rev-1' as SessionRevision } }
    expect(engine.commitSession(file, 'rev-0' as SessionRevision)).toBeUndefined()
  })

  it('rejects an update to an unknown session', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    expect(() => engine.saveSession(makeFile(), 'rev-0' as SessionRevision)).toThrow(/not found/)
  })

  it('commits against a stored record without a blob map page', () => {
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    const rootPage = saveMultiPageTree(pages, fromEntries([]))
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 0,
      backups: [],
    })
    const first = engine.commitSession(
      { ...makeFile(0), session: { ...makeFile(0).session, revision: 'rev-1' as SessionRevision, nextEventCounter: 1 } },
      'rev-0' as SessionRevision,
    )
    expect(first?.revision).toBe('rev-1')
    // The second commit walks the rolling backup, whose record also has no
    // blob map page.
    const second = engine.commitSession(
      { ...makeFile(0), session: { ...makeFile(0).session, revision: 'rev-2' as SessionRevision, nextEventCounter: 2 } },
      'rev-1' as SessionRevision,
    )
    expect(second?.revision).toBe('rev-2')
  })

  it('rejects a saveSession whose expected revision is stale', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    expect(() => engine.saveSession(makeFile(), 'rev-stale' as SessionRevision)).toThrow(/must advance past/)
    const advanced = { ...makeFile(), session: { ...makeFile().session, revision: 'rev-2' as SessionRevision } }
    expect(() => engine.saveSession(advanced, 'rev-1' as SessionRevision)).toThrow(/revision mismatch/)
  })

  it('returns the published record with backups from an update save', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile())
    const withBlobs = withReplacementBlobs(engine.loadSession(sessionId()), [200])
    const published = engine.saveSession({ ...withBlobs, session: { ...withBlobs.session, revision: 'rev-1' as SessionRevision } }, 'rev-0' as SessionRevision)
    expect(published.revision).toBe('rev-1')
    expect(published.backups).toHaveLength(1)
  })

  it('rejects a saveSession with dangling reference or summary event ids', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(3)
    const danglingFrom: SessionFile = {
      ...file,
      references: [{ fromEventId: 'evt_missing' as EventId, refName: 'x', toEventIds: [eventId(1)] }],
    }
    expect(() => engine.saveSession(danglingFrom)).toThrow(/reference sources missing event/)
    const danglingTo: SessionFile = {
      ...file,
      references: [{ fromEventId: eventId(1), refName: 'x', toEventIds: ['evt_missing' as EventId] }],
    }
    expect(() => engine.saveSession(danglingTo)).toThrow(/reference targets missing event/)
    const danglingSummary: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: 'evt_missing' as EventId,
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: eventId(1), endId: eventId(2) },
        shadowedIds: [eventId(1)],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(danglingSummary)).toThrow(/checkpoint .* is not an event/)
  })

  it('rejects a saveSession with non-finite order or duplicate references', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(3)
    const nonFinite = {
      ...file,
      entries: [file.entries[0]!, { ...file.entries[1]!, order: Number.NaN }, file.entries[2]!],
    }
    expect(() => engine.saveSession(nonFinite)).toThrow(/order must be finite/)
    const duplicateReference: SessionFile = {
      ...file,
      references: [
        { fromEventId: eventId(1), refName: 'x', toEventIds: [eventId(0)] },
        { fromEventId: eventId(1), refName: 'x', toEventIds: [eventId(2)] },
      ],
    }
    expect(() => engine.saveSession(duplicateReference)).toThrow(/duplicate reference/)
  })

  it('rejects a saveSession whose entries reference missing blobs', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(2)
    const broken = { ...file, entries: [{ ...file.entries[0]!, blobId: 'blob_missing' as BlobId }] }
    expect(() => engine.saveSession(broken)).toThrow(/references missing blob/)
  })

  it('rejects a saveSession violating file invariants', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(3)
    expect(() => engine.saveSession({ ...file, session: { ...file.session, formatVersion: 2 } }))
      .toThrow(/formatVersion must be 1/)
    expect(() => engine.saveSession({ ...file, session: { ...file.session, nextEventCounter: Number.NaN } }))
      .toThrow(/nextEventCounter must be a non-negative safe integer/)
    expect(() => engine.saveSession({ ...file, session: { ...file.session, nextEventCounter: 1 } }))
      .toThrow(/nextEventCounter must exceed the highest used EventId/)
    const plainId = {
      ...file,
      entries: file.entries.map(entry => ({ ...entry, eventId: entry.eventId.replace(/_\d+$/, '_x') as EventId })),
    }
    expect(() => engine.saveSession({ ...plainId, session: { ...plainId.session, nextEventCounter: 0 } }))
      .not.toThrow(/nextEventCounter must exceed/)
    const unsorted = {
      ...file,
      entries: [file.entries[1]!, file.entries[0]!, file.entries[2]!],
    }
    expect(() => engine.saveSession(unsorted)).toThrow(/strictly increasing order/)
    const duplicated = {
      ...file,
      entries: [file.entries[0]!, { ...file.entries[1]!, order: 0.5 }, file.entries[1]!],
    }
    expect(() => engine.saveSession(duplicated)).toThrow(/is duplicated/)
    const danglingSeed = { ...file, session: { ...file.session, seedBoundaryId: 'evt_missing' as EventId } }
    expect(() => engine.saveSession(danglingSeed)).toThrow(/seedBoundaryId .* targets a missing event/)
    const liveShadowed: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: eventId(1), endId: eventId(2) },
        shadowedIds: [eventId(1)],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(liveShadowed)).toThrow(/shadowedIds must not contain live event/)
    const danglingMarker: SessionFile = {
      ...file,
      compacted: [{
        ...liveShadowed.compacted[0]!,
        shadowedIds: ['evt_missing' as EventId],
        shadowedRange: { startId: 'evt_missing' as EventId, endId: 'evt_missing' as EventId },
        markerEventIds: { startEventId: eventId(0), summaryEventId: 'evt_missing' as EventId, endEventId: eventId(0) },
      }],
    }
    expect(() => engine.saveSession(danglingMarker)).toThrow(/marker .* must be a live event/)
    const liveRange: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: eventId(0), endId: eventId(1) },
        shadowedIds: [],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(liveRange)).toThrow(/shadowedRange must not contain live event/)
    const rangeNotListed: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(rangeNotListed)).toThrow(/must be listed in shadowedIds/)
    const badSeqs: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(badSeqs)).toThrow(/shadowedSeqs must be non-empty and span/)
    const markerNotLive: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: 'evt_gone' as EventId,
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(markerNotLive)).toThrow(/marker .* must be a live event/)
    const duplicateTargets: SessionFile = {
      ...file,
      references: [{ fromEventId: eventId(1), refName: 'x', toEventIds: [eventId(0), eventId(0)] }],
    }
    expect(() => engine.saveSession(duplicateTargets)).toThrow(/targets .* more than once/)
    const markerCollision: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(2),
          summaryEventId: eventId(1),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(markerCollision)).toThrow(/marker ids must be pairwise distinct/)
    const badTokenCount: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: -1,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(badTokenCount)).toThrow(/full summary shape/)
    const badSummaryBlock: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [{ text: 'no type' }] as unknown as ContentBlock[],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(badSummaryBlock)).toThrow(/full summary shape/)
    const badUsage: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        usage: { inputTokens: 1 } as unknown as TokenUsage,
      }],
    }
    expect(() => engine.saveSession(badUsage)).toThrow(/full summary shape/)
    const badUsageOptional: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 'bad' } as unknown as TokenUsage,
      }],
    }
    expect(() => engine.saveSession(badUsageOptional)).toThrow(/full summary shape/)
    const badUsageCache: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 'bad', cacheWriteTokens: 'bad', reasoningTokens: 'bad' } as unknown as TokenUsage,
      }],
    }
    expect(() => engine.saveSession(badUsageCache)).toThrow(/full summary shape/)
    const badUsageValidOptionalFields: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 5 as unknown as string,
        model: 'test',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          reasoningTokens: 6,
        } as unknown as TokenUsage,
      }],
    }
    expect(() => engine.saveSession(badUsageValidOptionalFields)).toThrow(/full summary shape/)
    const nonRecordUsage: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        usage: 'not-an-object' as unknown as TokenUsage,
      }],
    }
    expect(() => engine.saveSession(nonRecordUsage)).toThrow(/full summary shape/)
    const badStreamRawOutput: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: true,
        rawOutput: [{ type: 'text' } as unknown as ContentBlock],
      }] as unknown as SessionFile['compacted'],
    }
    expect(() => engine.saveSession(badStreamRawOutput)).toThrow(/full summary shape/)
    const badSourceCommand: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: 5,
        maxTokens: 'many',
      }] as unknown as SessionFile['compacted'],
    }
    expect(() => engine.saveSession(badSourceCommand)).toThrow(/full summary shape/)
    const badMaxTokens: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        maxTokens: 'many',
      }] as unknown as SessionFile['compacted'],
    }
    expect(() => engine.saveSession(badMaxTokens)).toThrow(/full summary shape/)
    const badFlag: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: false,
      }] as unknown as SessionFile['compacted'],
    }
    expect(() => engine.saveSession(badFlag)).toThrow(/full summary shape/)
    const missingRawOutput: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: true,
      }] as unknown as SessionFile['compacted'],
    }
    expect(() => engine.saveSession(missingRawOutput)).toThrow(/full summary shape/)
    const badRawOutputBlock: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(2),
          endEventId: eventId(0),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        rawOutput: [{ text: 'no type' }] as unknown as ContentBlock[],
      }],
    }
    expect(() => engine.saveSession(badRawOutputBlock)).toThrow(/full summary shape/)
  })

  it('rejects a saveSession whose counter sits below a compaction-shadowed EventId', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(3)
    const shadowedHigh: SessionFile = {
      ...file,
      session: { ...file.session, nextEventCounter: 10 },
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(10),
          summaryEventId: eventId(11),
          endEventId: eventId(12),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_50' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_50' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(shadowedHigh))
      .toThrow(/nextEventCounter must exceed the highest used EventId/)
  })

  it('rejects a saveSession whose marker or checkpoint blob is not a compaction envelope', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const wrongMarkerType: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    // evt_0 carries a plain user/message envelope, not a compaction/start marker.
    expect(() => engine.saveSession(wrongMarkerType)).toThrow(/compaction\/start marker/)
    const wrongCheckpoint: SessionFile = {
      ...file,
      // The three markers point at real compaction envelopes (blob_101/102/103)
      // in the contiguous start/summary/checkpoint/end order; only the
      // checkpoint points at a plain user/message envelope whose blob has no
      // checkpoint source, so the pointer cannot be a genuine checkpoint.
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(0) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(wrongCheckpoint))
      .toThrow(/checkpoint .* must be a user\/message surface event carrying a replace surfaceOp/)
    // A marker blob that is not valid JSON, and one that is JSON but not an
    // object, must both be rejected rather than treated as envelopes.
    const notJsonMarker: SessionFile = {
      ...file,
      blobs: new Map(file.blobs).set(blobId(0), new TextEncoder().encode('not json {')),
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(notJsonMarker)).toThrow(/compaction\/start marker/)
    const arrayMarker: SessionFile = {
      ...file,
      blobs: new Map(file.blobs).set(blobId(0), new TextEncoder().encode('[]')),
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(arrayMarker)).toThrow(/compaction\/start marker/)
    // A reordered marker group must be rejected even when every blob is a
    // correct envelope: the persisted bracket order is part of the contract.
    const reorderedMarkers: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(3),
          summaryEventId: eventId(0),
          endEventId: eventId(1),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(reorderedMarkers))
      .toThrow(/marker events must be ordered start, summary, checkpoint, end/)
  })

  it('accepts ordinary events between the start and summary and between checkpoint and end markers', () => {
    // The archive boundary (file.spec.ts) accepts non-marker entries between
    // start and summary and between checkpoint and end; only summary and
    // checkpoint must be adjacent. The engine publishes what the archive
    // accepts, so the same span rule must hold here.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const blobs = new Map(file.blobs)
    blobs.set(blobId(9), eventEnvelope(9))
    blobs.set(blobId(8), eventEnvelope(8))
    const spansGap: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        // An ordinary event between start and summary.
        { order: 1, eventId: eventId(9), blobId: blobId(9) },
        { order: 2, eventId: eventId(1), blobId: blobId(102) },
        { order: 3, eventId: eventId(2), blobId: blobId(100) },
        // An ordinary event between checkpoint and end.
        { order: 4, eventId: eventId(8), blobId: blobId(8) },
        { order: 5, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(engine.saveSession(spansGap).sessionId).toBe(sessionId())
  })

  it('rejects a checkpoint whose replace range disagrees with the summary shadowedSeqRange', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    // The checkpoint blob 100 carries a replace range over {1,3}; a side
    // table claiming {1,2} must be rejected because replay pairs the
    // checkpoint with the summary's shadowedSeqRange.
    const mismatchedRange: SessionFile = {
      ...file,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(mismatchedRange))
      .toThrow(/must be a user\/message surface event carrying a replace surfaceOp over the summary's shadowedSeqRange/)
  })

  it('rejects a checkpoint that is not a user/message event', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    // blob 100 is normally a user/message checkpoint; point the checkpoint at
    // an assistant/message envelope instead: replay only recognizes
    // user/message checkpoints, so the engine must reject it too.
    const blobs = new Map(file.blobs).set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'assistant/message',
      time: 100,
      data: {
        id: 'a100',
        role: 'assistant',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    })))
    const assistantCheckpoint: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(assistantCheckpoint))
      .toThrow(/must be a user\/message surface event carrying a replace surfaceOp/)
  })

  it('rejects a checkpoint whose sourceEventSeqs omit a shadowed seq', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    // The checkpoint must cite every shadowed seq; dropping one leaves the
    // coverage check unsatisfied even though the range and type are correct.
    const blobs = new Map(file.blobs).set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message',
      time: 100,
      data: {
        id: 'm100',
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1],
    })))
    const missingSeq: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(missingSeq))
      .toThrow(/must be a user\/message surface event carrying a replace surfaceOp/)
  })

  it('rejects a checkpoint whose sourceEventSeqs carry a non-safe integer', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const blobs = new Map(file.blobs).set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message',
      time: 100,
      data: {
        id: 'm100',
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 1.5],
    })))
    const unsafeSeq: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(unsafeSeq))
      .toThrow(/must be a user\/message surface event carrying a replace surfaceOp/)
  })

  it('rejects a checkpoint without a sourceEventSeqs array', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const blobs = new Map(file.blobs).set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message',
      time: 100,
      data: {
        id: 'm100',
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
    })))
    const noSourceSeqs: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(noSourceSeqs))
      .toThrow(/must be a user\/message surface event carrying a replace surfaceOp/)
  })

  it('accepts a summary with a fully populated valid usage record', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    // The archive boundary requires the summary marker blob to mirror the
    // side table (file.ts deepEqualJson per field), so the blob must carry
    // the same sourceCommandId and usage the side table declares. The whole
    // marker group must share one sourceCommandId with the checkpoint source
    // (file.ts), so every marker carries 'cmd_1'.
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary',
      time: 102,
      data: {
        compactionId: 'compact_1',
        summary: [],
        shadowedRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: 'cmd_1',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          reasoningTokens: 6,
        },
      },
    })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 101,
      data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_1' },
    })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/end', time: 103,
      data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_1' },
    })))
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message',
      time: 100,
      data: {
        id: 'm100',
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'compact_1',
          sourceCommandId: 'cmd_1',
        },
      },
      surfaceOp: { op: 'replace', start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
    })))
    const withValidUsage: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        // The checkpoint envelope (blob 100) derives its replace range from
        // the summary blob at 102, which describes three shadowed seqs, so
        // the side table must agree on {1,3}.
        shadowedSeqRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: 'cmd_1' as never,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          reasoningTokens: 6,
        } as unknown as TokenUsage,
      }],
    }
    const saved = engine.saveSession(withValidUsage)
    expect(saved.sessionId).toBe(sessionId())
  })

  it('rejects a marker blob missing its turn at the publish round-trip', () => {
    // validateSessionFile accepts a start marker with the right type and
    // compactionId; the archive boundary additionally requires the bracket
    // markers to carry a numeric or null turn, so the serialize→deserialize
    // round-trip at publish rejects the file before it is committed.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const blobs = new Map(file.blobs).set(blobId(101), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 101,
      data: { compactionId: 'compact_1' },
    })))
    const noTurn: SessionFile = {
      ...file,
      blobs,
      entries: [
        { order: 0, eventId: eventId(0), blobId: blobId(101) },
        { order: 1, eventId: eventId(1), blobId: blobId(102) },
        { order: 2, eventId: eventId(2), blobId: blobId(100) },
        { order: 3, eventId: eventId(3), blobId: blobId(103) },
      ],
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(noTurn))
      .toThrow(/marker event .* must carry a numeric or null turn/)
  })

  it('rejects a summary with an empty sourceCommandId', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(4)
    const emptyCommand: SessionFile = {
      ...file,
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: '' as never,
      }],
    }
    expect(() => engine.saveSession(emptyCommand))
      .toThrow(/compaction summary entries must carry the full summary shape/)
    // An empty compactionId fails the same shape check.
    const emptyCompaction: SessionFile = {
      ...file,
      compacted: [{
        compactionId: '' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(3),
        },
        shadowedRange: { startId: 'evt_retired_1' as EventId, endId: 'evt_retired_2' as EventId },
        shadowedIds: ['evt_retired_1' as EventId, 'evt_retired_2' as EventId],
        shadowedSeqRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    }
    expect(() => engine.saveSession(emptyCompaction))
      .toThrow(/compaction summary entries must carry the full summary shape/)
  })

  it('accepts a CAS update when an imported backup lacks a blob map page', () => {
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    let tree = SessionTree.empty()
    for (let i = 0; i < 2; i++) tree = tree.append(eventId(i), blobId(i))
    const rootPage = saveMultiPageTree(pages, fromEntries(tree.entries()))
    const blobMapPage = saveBlobMap(pages, new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(1), eventEnvelope(1)],
    ]))
    // Import a record whose only backup lacks a blob map page, then run a
    // CAS update: the update must tolerate the pointer-less backup.
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      blobMapPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 100,
      backups: [{ rootPage: 'page_orphan' as PageId }],
    })
    const current = engine.loadSession(sessionId())
    const updated = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
    }
    expect(engine.saveSession(updated, current.session.revision).revision).toBe('rev-1')
  })

  it('accepts a CAS update when an imported backup root is an empty tree', () => {
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    let tree = SessionTree.empty()
    for (let i = 0; i < 2; i++) tree = tree.append(eventId(i), blobId(i))
    const rootPage = saveMultiPageTree(pages, fromEntries(tree.entries()))
    const blobMapPage = saveBlobMap(pages, new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(1), eventEnvelope(1)],
    ]))
    // An empty tree backup resolves to no entries; the EventId-binding scan
    // must tolerate it rather than fail the update.
    const emptyRoot = saveMultiPageTree(pages, undefined)
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      blobMapPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 100,
      backups: [{ rootPage: emptyRoot }],
    })
    const current = engine.loadSession(sessionId())
    const updated = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
    }
    expect(engine.saveSession(updated, current.session.revision).revision).toBe('rev-1')
  })

  it('folds a newly appended entry into the binding table on a CAS update', () => {
    // A CAS update that adds an entry mints a new EventId binding that must
    // enter the durable table so a later rebind is refused.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const blobs = new Map(current.blobs).set(blobId(9), eventEnvelope(9))
    const appended = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: [...current.entries, { order: 9, eventId: eventId(9), blobId: blobId(9) }],
      blobs,
    }
    const saved = engine.saveSession(appended, current.session.revision)
    expect(saved.revision).toBe('rev-1')
    expect(saved.usedEventBindings?.get(eventId(9))).toBe(blobId(9))
    // Rebinding the appended event is now refused.
    const afterAppend = engine.loadSession(sessionId())
    const reboundBlobs = new Map(afterAppend.blobs).set(blobId(88), eventEnvelope(9))
    const rebound = {
      ...afterAppend,
      session: { ...afterAppend.session, revision: 'rev-2' as SessionRevision },
      entries: afterAppend.entries.map(entry =>
        entry.eventId === eventId(9) ? { ...entry, blobId: blobId(88) } : entry),
      blobs: reboundBlobs,
    }
    expect(() => engine.saveSession(rebound, afterAppend.session.revision))
      .toThrow(/session file event evt_sess_engine_9 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('compacts a record imported without the usedEventBindings field', () => {
    // A record injected directly into the store (import path) may lack the
    // durable binding table; compact must default it to empty and carry the
    // new baseline forward.
    const pages = new PageStore()
    const store = new SessionStore()
    const engine = new SessionFormatEngine(pages, store)
    let tree = SessionTree.empty()
    for (let i = 0; i < 6; i++) tree = tree.append(eventId(i), blobId(i))
    const rootPage = saveMultiPageTree(pages, fromEntries(tree.entries()))
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 6; i++) blobs.set(blobId(i), eventEnvelope(i))
    // The compaction's four replacement blobs must already exist as envelopes.
    blobs.set(blobId(100), replacementEnvelope(100, 'user/message', 'compact_1'))
    blobs.set(blobId(101), replacementEnvelope(101, 'compaction/start', 'compact_1'))
    blobs.set(blobId(102), replacementEnvelope(102, 'compaction/summary', 'compact_1'))
    blobs.set(blobId(103), replacementEnvelope(103, 'compaction/end', 'compact_1'))
    const blobMapPage = saveBlobMap(pages, blobs)
    // No usedEventBindings on the imported record.
    store.putSession({
      sessionId: sessionId(),
      formatVersion: 1,
      rootPage,
      blobMapPage,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: 100,
      backups: [],
    })
    const ok = engine.compact(sessionId(), compactionInput('rev-1'))
    expect(ok).toBeDefined()
    expect(engine.loadSession(sessionId()).session.usedEventBindings).toBeDefined()
  })

  it('rejects rebinding a compaction-minted marker after compact', () => {
    // compact() folds the four minted marker events into the binding table;
    // a subsequent CAS update rebinding a marker EventId to a fresh blob with
    // identical bytes must be refused.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(5))
    const ok = engine.compact(sessionId(), compactionInput('rev-1'))
    expect(ok).toBeDefined()
    const current = engine.loadSession(sessionId())
    // The start marker event is evt_101; rebind it to a fresh identical blob.
    const fresh = new Map(current.blobs)
    const priorBytes = fresh.get(blobId(101)) ?? new Uint8Array()
    fresh.set(blobId(88), new TextEncoder().encode(new TextDecoder().decode(priorBytes)))
    const rebound = {
      ...current,
      session: { ...current.session, revision: 'rev-2' as SessionRevision },
      entries: current.entries.map(entry =>
        entry.eventId === eventId(101) ? { ...entry, blobId: blobId(88) } : entry),
      blobs: fresh,
    }
    expect(() => engine.saveSession(rebound, current.session.revision))
      .toThrow(/session file event evt_sess_engine_101 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('rejects a CAS update that rewrites a blob retained in a backup generation', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    // Drop blob 1 from the current generation so the next commit retains it
    // in the backup's blob map page.
    const dropped = engine.loadSession(sessionId())
    const withoutBlob = {
      ...dropped,
      session: { ...dropped.session, revision: 'rev-1' as SessionRevision },
      entries: dropped.entries.filter(entry => entry.blobId !== blobId(1)),
      blobs: new Map([...dropped.blobs].filter(([id]) => id !== blobId(1))),
    }
    engine.saveSession(withoutBlob, dropped.session.revision)
    expect(engine.loadSession(sessionId()).blobs.has(blobId(1))).toBe(false)
    // Re-add blob 1 under the same id with different bytes: the retained
    // backup generation still pins the original content.
    const current = engine.loadSession(sessionId())
    const tampered = {
      ...current,
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    let caught: unknown
    try {
      engine.saveSession(tampered, current.session.revision)
    } catch (error) {
      caught = error
    }
    expect(String(caught)).toContain('immutable')
  })

  it('rejects a CAS update that rewrites an existing blob', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const tampered = {
      ...current,
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    expect(() => engine.saveSession(tampered, current.session.revision))
      .toThrow(/immutable/)
  })

  it('rejects a previous-file commit that rewrites an existing blob', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const tampered = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    // The repository append path passes the loaded previous generation; the
    // in-memory immutability check must still reject a rewritten payload.
    expect(() => engine.commitSession(tampered, current.session.revision, current))
      .toThrow(/immutable/)
  })

  it('rejects a previous-file commit that reintroduces a backup-retained blob', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    // Drop blob 1 from the current generation so the backup retains it.
    const dropped = engine.loadSession(sessionId())
    const withoutBlob = {
      ...dropped,
      session: { ...dropped.session, revision: 'rev-1' as SessionRevision },
      entries: dropped.entries.filter(entry => entry.blobId !== blobId(1)),
      blobs: new Map([...dropped.blobs].filter(([id]) => id !== blobId(1))),
    }
    engine.saveSession(withoutBlob, dropped.session.revision)
    // Reintroduce blob 1 with different bytes through the previous-file
    // commit: the id is absent from the in-memory previous map, so the
    // check reads the retained backup page lazily and must still reject.
    const current = engine.loadSession(sessionId())
    const reintroduced = {
      ...current,
      session: { ...current.session, revision: 'rev-2' as SessionRevision },
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    expect(() => engine.commitSession(reintroduced, current.session.revision, current))
      .toThrow(/immutable/)
  })

  it('ignores a previous-file snapshot whose revision does not match the stored record', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    // A caller-passed previous generation from a different generation is
    // ignored: the commit loads the real current generation instead, and the
    // rewritten blob is still rejected.
    const stalePrevious = { ...current, session: { ...current.session, revision: 'rev-999' as SessionRevision } }
    const tampered = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      blobs: new Map(current.blobs).set(blobId(1), new TextEncoder().encode('tampered')),
    }
    expect(() => engine.commitSession(tampered, current.session.revision, stalePrevious))
      .toThrow(/immutable/)
  })

  it('rejects a record whose blob watermark sits below a numeric blob id', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(1)
    const lowWatermark = {
      ...file,
      session: { ...file.session, blobIdWatermark: 2 },
      blobs: new Map(file.blobs).set(blobId(5), new TextEncoder().encode('unreferenced')),
    }
    // The record-level watermark check refuses a watermark below a numeric
    // id in the file's own map, so a hand-built or imported record can never
    // mint a colliding blob id.
    expect(() => engine.saveSession(lowWatermark)).toThrow(/blob watermark/)
  })

  it('rejects a CAS update that rebinds a surviving EventId to a new blob', () => {
    // EventIds are stable identity: keeping the event but pointing it at a
    // different blob would make the current root and a rolling backup resolve
    // the same EventId to different events. The update must refuse the
    // rebinding even though every blob's bytes are unchanged.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const rebindable = new Map(current.blobs)
    // A fresh blob with identical content to blob 1's payload, so the blob
    // immutability check alone cannot catch the rebinding.
    const priorBytes = rebindable.get(blobId(1)) ?? new Uint8Array()
    const freshBlob = new TextEncoder().encode(new TextDecoder().decode(priorBytes))
    const freshId = blobId(99)
    rebindable.set(freshId, freshBlob)
    const rebound = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: current.entries.map(entry =>
        entry.eventId === eventId(1) ? { ...entry, blobId: freshId } : entry),
      blobs: rebindable,
    }
    expect(() => engine.saveSession(rebound, current.session.revision))
      .toThrow(/session file event evt_sess_engine_1 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('allows a CAS update that removes an entry entirely', () => {
    // Removing an event (compaction, fork truncation) is legitimate; only
    // rebinding a surviving EventId is refused.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const removed = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: current.entries.filter(entry => entry.eventId !== eventId(1)),
    }
    expect(engine.saveSession(removed, current.session.revision).revision).toBe('rev-1')
  })

  it('rejects re-adding a removed EventId under a different blob', () => {
    // An EventId removed in one generation stays bound to its original blob
    // in the durable usedEventBindings table; re-adding the same EventId with
    // a fresh blob must be refused even though the old binding no longer
    // appears in the current generation.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    // Remove event 1 so its binding enters the durable table via the commit.
    const current = engine.loadSession(sessionId())
    const removed = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: current.entries.filter(entry => entry.eventId !== eventId(1)),
    }
    engine.saveSession(removed, current.session.revision)
    // Re-add event 1 pointing at a fresh blob with identical content.
    const afterRemoval = engine.loadSession(sessionId())
    const fresh = new Map(afterRemoval.blobs)
    const priorBytes = fresh.get(blobId(1)) ?? new Uint8Array()
    const freshBlob = new TextEncoder().encode(new TextDecoder().decode(priorBytes))
    fresh.set(blobId(99), freshBlob)
    const reAdded = {
      ...afterRemoval,
      session: { ...afterRemoval.session, revision: 'rev-2' as SessionRevision },
      entries: [...afterRemoval.entries, { order: 9, eventId: eventId(1), blobId: blobId(99) }],
      blobs: fresh,
    }
    expect(() => engine.saveSession(reAdded, afterRemoval.session.revision))
      .toThrow(/session file event evt_sess_engine_1 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('rejects rebinding even with zero retained backup generations', () => {
    // The used-binding guard lives in the durable record, not in the retained
    // backups: with maxBackupGenerations=0 no backup survives, yet the
    // re-added EventId is still refused.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore(0))
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const removed = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: current.entries.filter(entry => entry.eventId !== eventId(1)),
    }
    engine.saveSession(removed, current.session.revision)
    const afterRemoval = engine.loadSession(sessionId())
    const fresh = new Map(afterRemoval.blobs)
    const priorBytes = fresh.get(blobId(1)) ?? new Uint8Array()
    const freshBlob = new TextEncoder().encode(new TextDecoder().decode(priorBytes))
    fresh.set(blobId(99), freshBlob)
    const reAdded = {
      ...afterRemoval,
      session: { ...afterRemoval.session, revision: 'rev-2' as SessionRevision },
      entries: [...afterRemoval.entries, { order: 9, eventId: eventId(1), blobId: blobId(99) }],
      blobs: fresh,
    }
    expect(() => engine.saveSession(reAdded, afterRemoval.session.revision))
      .toThrow(/session file event evt_sess_engine_1 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('rejects a fresh session file whose entries conflict with its own binding table', () => {
    // An import/export restore keeps historical bindings; an entry that
    // binds an EventId differently from the file's own table is rejected.
    const file = makeFile(3)
    const conflicting = {
      ...file,
      session: {
        ...file.session,
        usedEventBindings: new Map([[eventId(0), blobId(99)] as const]),
      },
    }
    expect(() => new SessionFormatEngine(new PageStore(), new SessionStore()).saveSession(conflicting))
      .toThrow(/session file event evt_sess_engine_0 (is immutable|binding conflicts with the file's usedEventBindings)/)
  })

  it('registers a fresh session carrying historical bindings', () => {
    // An import/export restore carries retired bindings in the table; the
    // fresh registration must keep them alongside the live entries.
    const file = makeFile(3)
    const withHistory = {
      ...file,
      session: {
        ...file.session,
        usedEventBindings: new Map([[eventId(0), blobId(0)], [eventId(7), blobId(7)] as const]),
      },
    }
    const saved = new SessionFormatEngine(new PageStore(), new SessionStore()).saveSession(withHistory)
    expect(saved.usedEventBindings?.get(eventId(0))).toBe(blobId(0))
    expect(saved.usedEventBindings?.get(eventId(7))).toBe(blobId(7))
  })

  it('rejects a CAS update that mints an EventId outside the session namespace', () => {
    // A new EventId must use this session's own prefix; a foreign-prefix id
    // (for example evt_sess_parent_*) would collide with the parent's identity
    // for the same EventId.
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(3))
    const current = engine.loadSession(sessionId())
    const blobs = new Map(current.blobs).set(blobId(9), eventEnvelope(9))
    const foreign = {
      ...current,
      session: { ...current.session, revision: 'rev-1' as SessionRevision },
      entries: [...current.entries, { order: 9, eventId: 'evt_sess_other_9' as EventId, blobId: blobId(9) }],
      blobs,
    }
    expect(() => engine.saveSession(foreign, current.session.revision))
      .toThrow(/event evt_sess_other_9 must use this session's own EventId prefix/)
  })

  it('drops input file backups when registering a fresh session', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    const file = makeFile(2)
    const withBackups = {
      ...file,
      session: { ...file.session, backups: [{ rootPage: 'page_stale' as PageId }] },
    }
    const published = engine.saveSession(withBackups)
    expect(published.backups).toEqual([])
    // GC must not chase the dropped backup's page pointers.
    expect(engine.gc()).toBeGreaterThanOrEqual(0)
  })

  it('keeps entry order monotonic across consecutive compactions of replacement entries', () => {
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(makeFile(8))
    expect(engine.compact(sessionId(), compactionInput())).toBeDefined()
    const second: Parameters<SessionFormatEngine['compact']>[1] = {
      ...compactionInput('rev-2'),
      // Shadow the full first transaction group (checkpoint + markers) so
      // the range does not cut an earlier transaction in half.
      shadowedIds: [eventId(100), eventId(101), eventId(102), eventId(103)],
      checkpointEventId: eventId(300),
      checkpointBlobId: blobId(300),
      compactionId: 'compact_2' as CompactionId,
      nextEventCounter: 400,
      startEventId: eventId(301),
      summaryEventId: eventId(302),
      endEventId: eventId(303),
      startBlobId: blobId(301),
      summaryBlobId: blobId(302),
      endBlobId: blobId(303),
      nextRevision: 'rev-3' as SessionRevision,
    }
    const withBlobs = withReplacementBlobs(engine.loadSession(sessionId()), [300, 301, 302, 303])
    engine.saveSession({ ...withBlobs, session: { ...withBlobs.session, revision: 'rev-2' as SessionRevision } }, 'rev-1' as SessionRevision)
    expect(engine.compact(sessionId(), second)).toBeDefined()
    const loaded = engine.loadSession(sessionId())
    const orders = loaded.entries.map(entry => entry.order)
    expect([...orders].sort((left, right) => left - right)).toEqual(orders)
  })
})

import { describe, expect, it } from 'vitest'
import { SessionTree } from '../src/btree.ts'
import type { CompactionInput } from '../src/compaction.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import type { SessionFile } from '../src/file.ts'
import type { BlobId, CompactionId, EventId, SessionId, SessionRevision } from '../src/index.ts'
import { PageStore } from '../src/page-store.ts'
import { advanceProjection } from '../src/projection.ts'
import type { ProjectionState } from '../src/projection.ts'
import type { NewSessionFile } from '../src/repository.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'

const SESSION_ID = 'sess_repo' as SessionId

function sessionId(): SessionId {
  return SESSION_ID
}

function eventId(n: number): EventId {
  return `evt_sess_repo_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes)
}

function eventEnvelope(seq: number): Uint8Array {
  return encode(JSON.stringify({ type: 'user/message', time: seq, data: { text: `event-${seq}` }, surfaceOp: 'append' }))
}

function surfaceAppend(text: string): Uint8Array {
  return encode(JSON.stringify({ type: 'user/message', time: 1, data: { text }, surfaceOp: 'append' }))
}



function newFile(
  entries: SessionFile['entries'] = [],
  blobs: ReadonlyMap<BlobId, Uint8Array> = new Map(),
): NewSessionFile {
  let counter = 0
  for (const entry of entries) {
    const match = /_(\d+)$/.exec(entry.eventId)
    if (match !== null) {
      const value = Number(match[1])
      if (Number.isSafeInteger(value) && value >= counter) counter = value + 1
    }
  }
  const session = {
    sessionId: sessionId(),
    formatVersion: 1,
    nextEventCounter: counter,
    backups: [],
  }
  return { session, entries, blobs, references: [], compacted: [] }
}

function compactionInput(): Omit<CompactionInput, 'nextRevision' | 'nextEventCounter'> {
  return {
    shadowedIds: [eventId(0), eventId(1)],
    checkpointEventId: eventId(100),
    checkpointBlobId: blobId(100),
    compactionId: 'compact_1' as CompactionId,
    startEventId: eventId(101),
    summaryEventId: eventId(102),
    endEventId: eventId(103),
    startBlobId: blobId(101),
    summaryBlobId: blobId(102),
    endBlobId: blobId(103),
  }
}


function replacementBlobs(): ReadonlyMap<BlobId, Uint8Array> {
  // The two shadowed surface events are evt_0/evt_1, so the checkpoint's
  // replace range, the summary's shadowed facts, and the provenance seqs all
  // describe seqs 1..2 (surface-lineage positions, 1-based).
  const seqs = [1, 2]
  const envelope = (type: string, data: Record<string, unknown>, turn: number | null = null): Uint8Array => {
    // surfaceOp and sourceEventSeqs sit at the envelope top level; the rest
    // of the message object (including the provenance source) lives in data.
    const { surfaceOp, sourceEventSeqs, ...rest } = data
    const body: Record<string, unknown> = { type, time: 1, data: { compactionId: 'compact_1', turn, ...rest } }
    if (surfaceOp !== undefined) body.surfaceOp = surfaceOp
    if (sourceEventSeqs !== undefined) body.sourceEventSeqs = sourceEventSeqs
    return encode(JSON.stringify(body))
  }
  const summary = {
    summary: [{ type: 'text', text: 'checkpoint' }],
    shadowedTokenCount: 1,
    provider: 'test',
    model: 'test',
    shadowedRange: { start: 1, end: 2 },
    shadowedSeqs: seqs,
  }
  return new Map([
    // The checkpoint is a surface user message: the message object (id, role,
    // content, provenance source) lives in `data` with the replace surfaceOp
    // and the shadowed-surface provenance at the envelope top level.
    [blobId(100), envelope('user/message', {
      id: 'm100',
      role: 'user',
      content: [{ type: 'text', text: 'checkpoint' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: seqs,
      shadowedTokenCount: 1,
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: seqs,
    })],
    [blobId(101), envelope('compaction/start', { marker: 101 })],
    [blobId(102), envelope('compaction/summary', summary)],
    [blobId(103), envelope('compaction/end', { marker: 103 })],
  ])
}

function harness(): { repository: SessionRepository; engine: SessionFormatEngine; store: SessionStore; pages: PageStore } {
  const pages = new PageStore()
  const store = new SessionStore()
  const engine = new SessionFormatEngine(pages, store)
  return { repository: new SessionRepository(engine), engine, store, pages }
}

describe('SessionRepository', () => {
  it('creates, appends, loads, forks, compacts, and collects garbage', () => {
    const { repository, pages } = harness()
    repository.createSession(newFile())
    expect(repository.loadSession(sessionId()).session.revision).toBe('rev-0')

    const first = repository.append(sessionId(), surfaceAppend('first'))
    expect(first?.revision).toBe('rev-1')
    repository.append(sessionId(), surfaceAppend('second'))

    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries).toHaveLength(2)
    expect(loaded.entries[0]?.eventId).toBe(eventId(0))
    expect(loaded.entries[1]?.eventId).toBe(eventId(1))
    expect(decode(loaded.blobs.get(loaded.entries[0]?.blobId ?? blobId(-1)))).toContain('first')
    expect(decode(loaded.blobs.get(loaded.entries[1]?.blobId ?? blobId(-1)))).toContain('second')

    const child = repository.fork(sessionId(), eventId(1), 'sess_child' as SessionId)
    expect(child.sessionId).toBe('sess_child')
    expect(repository.loadSession('sess_child' as SessionId).entries).toHaveLength(2)

    const summary = repository.compact(sessionId(), compactionInput(), replacementBlobs())
    expect(summary?.compactionId).toBe('compact_1' as CompactionId)
    expect(summary?.shadowedIds).toEqual([eventId(0), eventId(1)])
    const compacted = repository.loadSession(sessionId())
    expect(compacted.entries).toHaveLength(4)
    expect(compacted.entries[1]?.eventId).toBe(eventId(102))
    expect(compacted.session.revision).toBe('rev-3')

    const before = pages.size
    const removed = repository.gc()
    expect(removed).toBe(before - pages.size)
    // GC must keep every page a live session references: reload and read blobs.
    const afterGc = repository.loadSession(sessionId())
    expect(afterGc.entries).toHaveLength(4)
    expect(afterGc.blobs.has(blobId(100))).toBe(true)
    expect(repository.loadSession('sess_child' as SessionId).entries).toHaveLength(2)
    expect(decode(repository.loadSession('sess_child' as SessionId).blobs.get(blobId(0)))).toContain('first')
  })

  it('defaults the initial revision to rev-0 and rejects malformed revisions', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    expect(repository.loadSession(sessionId()).session.revision).toBe('rev-0')
    // Registration without a supplied revision exercises the rev-0 default
    // and an empty backups array.
    repository.createSession({ ...newFile(), session: { ...newFile().session, sessionId: 'sess_bare' as SessionId } })
    expect(repository.loadSession('sess_bare' as SessionId).session.revision).toBe('rev-0')
    expect(repository.loadSession('sess_bare' as SessionId).session.backups).toEqual([])
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, sessionId: 'sess_malformed' as SessionId, revision: 'v1' },
    })).toThrow(/rev-<n> form/)
    // A revision at the safe-integer ceiling cannot advance; registration must
    // fail at the earliest point instead of on the first append.
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, sessionId: 'sess_ceiling' as SessionId, revision: 'rev-9007199254740991' },
    })).toThrow(/cannot advance/)
    // One below the ceiling is equally frozen: the first advance would mint
    // the ceiling revision and every later write would fail.
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, sessionId: 'sess_ceiling' as SessionId, revision: 'rev-9007199254740990' },
    })).toThrow(/cannot advance/)
  })

  it('ignores a blob id whose numeric part exceeds the safe integer range', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_legacy' as EventId, blobId: 'blob_9007199254740992' as BlobId },
    ])
    const blobs = new Map<BlobId, Uint8Array>([['blob_9007199254740992' as BlobId, encode('legacy')]])
    repository.createSession(newFile(tree.entries(), blobs))
    // The numeric part parses but is not a safe integer; allocation starts
    // below it instead of deriving an unsafe watermark.
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.blobId).toBe(blobId(0))
  })

  it('does not treat a non-canonical blob id as a counter', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_legacy' as EventId, blobId: 'blob_1e3' as BlobId },
    ])
    const blobs = new Map<BlobId, Uint8Array>([['blob_1e3' as BlobId, encode('legacy')]])
    repository.createSession(newFile(tree.entries(), blobs))
    // 'blob_1e3' is not a canonical blob_<n> id: Number() would read 1000,
    // but the regex parse treats it as non-numeric and allocates blob_0.
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.blobId).toBe(blobId(0))
  })

  it('skips non-numeric event ids when allocating the next event', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_legacy' as EventId, blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), eventEnvelope(0)]])
    repository.createSession(newFile(tree.entries(), blobs))
    // 'evt_legacy' is not a canonical evt_<n> id; the counter ignores it and
    // the next event carries evt_sess_repo_1.
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.eventId).toBe('evt_sess_repo_0' as EventId)
  })

  it('derives the compacted counter above every replacement EventId', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: eventId(0), blobId: blobId(0) },
      { order: 1, eventId: eventId(1), blobId: blobId(1) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(1), eventEnvelope(1)],
    ])
    repository.createSession(newFile(tree.entries(), blobs))
    // The canonical replacement ids (100, 101, 102, 103) drive the counter to
    // one above the largest of them.
    repository.compact(sessionId(), compactionInput(), replacementBlobs())
    const loaded = repository.loadSession(sessionId())
    expect(Number(loaded.session.revision.replace('rev-', ''))).toBe(1)
    expect(loaded.session.nextEventCounter).toBe(104)
  })

  it('rejects a replacement event id that is not a canonical session id', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: eventId(0), blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), eventEnvelope(0)]])
    repository.createSession(newFile(tree.entries(), blobs))
    // The base format requires the session prefix and a numeric suffix; a
    // non-canonical or unsafe id is rejected instead of silently skipped.
    expect(() => repository.compact(sessionId(), {
      ...compactionInput(),
      startEventId: 'evt_5' as EventId,
    }, replacementBlobs())).toThrow(/must carry the session prefix/)
    expect(() => repository.compact(sessionId(), {
      ...compactionInput(),
      summaryEventId: 'evt_9007199254740992' as EventId,
    }, replacementBlobs())).toThrow(/must carry the session prefix/)
  })

  it('rejects a replacement EventId whose tail is below the event counter', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('a'))
    repository.append(sessionId(), surfaceAppend('b'))
    // The counter is 2; replacement ids 0..3 fall below the high-water and
    // would rebind ids the counter already advanced past.
    expect(() => repository.compact(sessionId(), {
      ...compactionInput(),
      startEventId: eventId(0),
      summaryEventId: eventId(1),
      checkpointEventId: eventId(2),
      endEventId: eventId(3),
    }, replacementBlobs())).toThrow(/at or above the event counter/)
  })

  it('rejects a replacement EventId with an unsafe numeric tail', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    expect(() => repository.compact(sessionId(), {
      ...compactionInput(),
      summaryEventId: `evt_sess_repo_${Number.MAX_SAFE_INTEGER + 1}` as EventId,
    }, replacementBlobs())).toThrow(/safe-integer tail/)
  })

  it('rejects a compact whose derived event counter reaches the ceiling', () => {
    const { repository } = harness()
    const file = newFile()
    const nearCeiling: NewSessionFile = {
      ...file,
      session: { ...file.session, nextEventCounter: Number.MAX_SAFE_INTEGER - 4 },
    }
    repository.createSession(nearCeiling)
    // Replacement ids at the high-water pass the counter check but push the
    // derived counter past the safe-integer range.
    const max = Number.MAX_SAFE_INTEGER
    expect(() => repository.compact(sessionId(), {
      ...compactionInput(),
      startEventId: `evt_sess_repo_${max - 4}` as EventId,
      summaryEventId: `evt_sess_repo_${max - 3}` as EventId,
      checkpointEventId: `evt_sess_repo_${max - 2}` as EventId,
      endEventId: `evt_sess_repo_${max - 1}` as EventId,
    }, replacementBlobs()))
      .toThrow(/event counter cannot advance/)
  })

  it('skips non-numeric blob ids when allocating the next blob', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([{ order: 0, eventId: 'evt_legacy' as EventId, blobId: 'blob_legacy' as BlobId }])
    const blobs = new Map<BlobId, Uint8Array>([['blob_legacy' as BlobId, encode('legacy')]])
    repository.createSession(newFile(tree.entries(), blobs))
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.blobId).toBe(blobId(0))
  })

  it('allocates above the persisted event counter when it exceeds visible tails', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: eventId(2), blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), eventEnvelope(0)]])
    repository.createSession({
      ...newFile(tree.entries(), blobs),
      session: { ...newFile().session, nextEventCounter: 10 },
    })
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    // The persisted high-water (10) dominates the visible tail (2): appending
    // allocates evt_..._10 and persists the advanced counter.
    expect(loaded.entries[1]?.eventId).toBe('evt_sess_repo_10' as EventId)
    expect(loaded.session.nextEventCounter).toBe(11)
  })

  it('assigns monotonic EventIds above existing counters and skips taken BlobIds', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_legacy_5' as EventId, blobId: blobId(0) },
      { order: 1, eventId: 'evt_legacy_3' as EventId, blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), encode('legacy')]])
    repository.createSession(newFile(tree.entries(), blobs))
    repository.append(sessionId(), encode('new'))

    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries.map(entry => entry.eventId)).toEqual(['evt_legacy_5' as EventId, 'evt_legacy_3' as EventId, eventId(6)])
    expect(loaded.entries.map(entry => entry.blobId)).toEqual([blobId(0), blobId(0), blobId(1)])
  })

  it('calibrates the blob watermark past numeric ids in the map at registration', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([{ order: 0, eventId: eventId(0), blobId: blobId(0) }])
    const blobs = new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(7), encode('unreferenced-7')],
      [blobId(3), encode('unreferenced-3')],
    ])
    repository.createSession(newFile(tree.entries(), blobs))
    // Registration calibrates the persisted watermark past the highest
    // numeric id (7) even though only blob_0 is referenced, so the first
    // append mints blob_8 instead of colliding with the map.
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.blobId).toBe(blobId(8))
  })

  it('never shadows an existing blob payload when appending', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_alpha' as EventId, blobId: blobId(0) },
      { order: 1, eventId: eventId(3), blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), encode('shared')]])
    repository.createSession(newFile(tree.entries(), blobs))
    const record = repository.append(sessionId(), encode('appended'))

    expect(record?.revision).toBe('rev-1')
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries).toHaveLength(3)
    const appended = loaded.entries[2]
    expect(appended?.eventId).toBe(eventId(4))
    expect(appended?.blobId).toBe(blobId(1))
    expect(decode(loaded.blobs.get(blobId(0)))).toBe('shared')
    expect(decode(loaded.blobs.get(appended?.blobId ?? blobId(-1)))).toBe('appended')
  })

  it('assigns the first counter when no event carries a numeric counter', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([{ order: 0, eventId: 'evt_bare' as EventId, blobId: blobId(0) }])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), encode('bare')]])
    repository.createSession(newFile(tree.entries(), blobs))
    repository.append(sessionId(), encode('next'))

    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries[1]?.eventId).toBe('evt_sess_repo_0' as EventId)
  })

  it('appends to a session whose id contains a line terminator', () => {
    const { repository } = harness()
    const weird = 'sess\nline' as SessionId
    repository.createSession({ ...newFile(), session: { ...newFile().session, sessionId: weird } })
    // The EventId inherits the session id's line terminator; the counter
    // parse must use the final separator, not a prefix regex that cannot
    // span newlines, so the append stays valid.
    const record = repository.append(weird, surfaceAppend('x'))
    expect(record?.revision).toBe('rev-1')
    const loaded = repository.loadSession(weird)
    expect(loaded.entries[0]?.eventId).toBe('evt_sess\nline_0' as EventId)
    expect(loaded.session.nextEventCounter).toBe(1)
  })

  it('rejects a commit whose expected revision is stale', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('first'))
    const file = engine.loadSession(sessionId())
    expect(file.session.revision).toBe('rev-1')
    // A snapshot derived from an older revision must not overwrite the store.
    expect(engine.commitSession(file, 'rev-0' as SessionRevision)).toBeUndefined()
    expect(engine.loadSession(sessionId()).session.revision).toBe('rev-1')
  })

  it('forces the committed revision past the current one on compact', () => {
    const { repository } = harness()
    const blobs = new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(1), eventEnvelope(1)],
      [blobId(2), eventEnvelope(2)],
    ])
    let tree = SessionTree.empty()
    for (let i = 0; i < 3; i++) tree = tree.append(eventId(i), blobId(i))
    repository.createSession(newFile(tree.entries(), blobs))
    repository.append(sessionId(), surfaceAppend('a'))
    repository.append(sessionId(), encode('b'))
    // The repository derives the next revision from the current rev-2 record;
    // the compact input does not carry a caller-supplied token.
    const summary = repository.compact(sessionId(), compactionInput(), replacementBlobs())
    expect(summary?.compactionId).toBe('compact_1' as CompactionId)
    expect(repository.loadSession(sessionId()).session.revision).toBe('rev-3')
  })

  it('rejects event counters and revisions beyond the safe integer range', () => {
    const { repository: fresh } = harness()
    // A persisted counter at the ceiling registers, but the next append
    // cannot advance and fails instead of allocating an untrackable id.
    fresh.createSession({
      ...newFile(),
      session: { ...newFile().session, nextEventCounter: Number.MAX_SAFE_INTEGER },
    })
    expect(() => fresh.append(sessionId(), encode('y'))).toThrow(/safe integer range/)

    // A counter above the safe integer range is rejected at registration.
    const { repository: freshUnsafe } = harness()
    expect(() => freshUnsafe.createSession({
      ...newFile(),
      session: { ...newFile().session, nextEventCounter: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow(/non-negative safe integer/)

    // Entries below the persisted high-water do not move the counter.
    const lowTree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_sess_repo_5' as EventId, blobId: blobId(0) },
    ])
    const { repository: freshLow } = harness()
    freshLow.createSession({
      ...newFile(lowTree.entries(), new Map([[blobId(0), encode('x')]])),
      session: { ...newFile(lowTree.entries()).session, nextEventCounter: 8 },
    })
    freshLow.append(sessionId(), encode('y'))
    expect(freshLow.loadSession(sessionId()).entries[1]?.eventId).toBe('evt_sess_repo_8' as EventId)

    for (const huge of ['9007199254740991', '9007199254740992']) {
      const { repository: fresh } = harness()
      // The revision ceiling is rejected at registration, the earliest point:
      // the safe MAX token cannot advance, and one past the safe-integer
      // range is not a valid rev-<n> token at all.
      expect(() => fresh.createSession({
        ...newFile(),
        session: { ...newFile().session, revision: `rev-${huge}` },
      })).toThrow(/cannot advance|rev-<n> form/)
    }
  })

  it('stops a registered session at the ceiling revision instead of minting rev-MAX', () => {
    const { repository } = harness()
    // rev-(MAX-2) is the highest registrable revision: the first advance
    // mints the ceiling, and the second write fails loud instead of minting
    // a rev-MAX token no later commit could advance.
    repository.createSession({
      ...newFile(),
      session: { ...newFile().session, revision: `rev-${Number.MAX_SAFE_INTEGER - 2}` },
    })
    expect(repository.append(sessionId(), surfaceAppend('a'))?.revision)
      .toBe(`rev-${Number.MAX_SAFE_INTEGER - 1}` as SessionRevision)
    expect(() => repository.append(sessionId(), surfaceAppend('b'))).toThrow(/cannot advance/)
  })

  it('rejects a commitSession whose revision does not advance', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('first'))
    const file = engine.loadSession(sessionId())
    // A snapshot committed with its own revision as the expected token would
    // leave the CAS token unchanged; the engine rejects it, as it does a
    // backwards revision.
    expect(() => engine.commitSession(file, file.session.revision)).toThrow(/must advance past/)
    const backwards = { ...file, session: { ...file.session, revision: 'rev-0' as SessionRevision } }
    expect(() => engine.commitSession(backwards, file.session.revision)).toThrow(/must advance past/)
  })

  it('rejects a direct engine compact whose next revision does not advance', () => {
    const { repository, engine } = harness()
    const blobs = new Map<BlobId, Uint8Array>([
      [blobId(0), eventEnvelope(0)],
      [blobId(1), eventEnvelope(1)],
    ])
    let tree = SessionTree.empty()
    for (let i = 0; i < 2; i++) tree = tree.append(eventId(i), blobId(i))
    repository.createSession(newFile(tree.entries(), blobs))
    // A direct engine caller can still supply a stalled token; the engine
    // fails loud instead of committing an unchanged revision. The caller
    // advances the watermark explicitly (the commit point now enforces it),
    // so the stalled revision is the only violation left.
    expect(() => engine.compact(
      sessionId(),
      { ...compactionInput(), nextRevision: 'rev-0' as SessionRevision, nextEventCounter: 200 },
      replacementBlobs(),
      103,
    )).toThrow(/must advance past/)
  })

  it('rejects replacement EventIds that an earlier compaction shadowed', () => {
    const { repository } = harness()
    let tree = SessionTree.empty()
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 3; i++) {
      tree = tree.append(eventId(i), blobId(i))
      blobs.set(blobId(i), eventEnvelope(i))
    }
    repository.createSession(newFile(tree.entries(), blobs))
    repository.compact(sessionId(), compactionInput(), replacementBlobs())
    // The second compaction must not reuse a shadowed id (evt_0/evt_1) as a
    // replacement EventId.
    const second = { ...compactionInput(), startEventId: eventId(0) }
    expect(() => repository.compact(sessionId(), second, replacementBlobs())).toThrow(/was shadowed/)
  })

  it('rejects a replacement blob id that does not advance the watermark', () => {
    const { repository } = harness()
    let tree = SessionTree.empty()
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 3; i++) {
      tree = tree.append(eventId(i), blobId(i))
      blobs.set(blobId(i), eventEnvelope(i))
    }
    repository.createSession(newFile(tree.entries(), blobs))
    // Advance the watermark once so low and non-numeric ids are provably below it.
    repository.append(sessionId(), surfaceAppend('first'))
    // A non-numeric replacement id, or one at or below the watermark, cannot
    // be a new blob identity.
    const bad = { ...compactionInput(), startBlobId: 'blob_x' as BlobId }
    const badBlobs = new Map(replacementBlobs())
    badBlobs.set('blob_x' as BlobId, replacementBlobs().get(blobId(101))!)
    expect(() => repository.compact(sessionId(), bad, badBlobs)).toThrow(/must advance past the blob watermark/)
    const low = { ...compactionInput(), startBlobId: blobId(0) }
    const lowBlobs = new Map(replacementBlobs())
    lowBlobs.set(blobId(0), replacementBlobs().get(blobId(101))!)
    expect(() => repository.compact(sessionId(), low, lowBlobs)).toThrow(/must advance past the blob watermark/)
  })

  it('requires this transaction to supply all four replacement blobs', () => {
    const { repository } = harness()
    let tree = SessionTree.empty()
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 3; i++) {
      tree = tree.append(eventId(i), blobId(i))
      blobs.set(blobId(i), eventEnvelope(i))
    }
    repository.createSession(newFile(tree.entries(), blobs))
    const partial = new Map(replacementBlobs())
    partial.delete(blobId(103))
    expect(() => repository.compact(sessionId(), compactionInput(), partial)).toThrow(/must be provided/)
  })

  it('accepts a seed boundary that references a present event', () => {
    const { repository } = harness()
    const tree = SessionTree.empty().append(eventId(0), blobId(0))
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), encode('x')]])
    const file = newFile(tree.entries(), blobs)
    repository.createSession({
      ...file,
      session: { ...file.session, seedBoundaryId: eventId(0) },
    })
    expect(repository.loadSession(sessionId()).session.seedBoundaryId).toBe(eventId(0))
  })

  it('rejects a malformed createdAt at registration', () => {
    const { repository } = harness()
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, createdAt: -1 },
    })).toThrow(/createdAt/)
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, createdAt: 0.5 },
    })).toThrow(/createdAt/)
  })

  it('rejects a malformed nextEventCounter at registration', () => {
    const { repository } = harness()
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, nextEventCounter: -1 },
    })).toThrow(/nextEventCounter/)
  })

  it('rejects a malformed blobIdWatermark at registration', () => {
    const { repository } = harness()
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, blobIdWatermark: 0.5 },
    })).toThrow(/blobIdWatermark/)
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, blobIdWatermark: -1 },
    })).toThrow(/blobIdWatermark/)
  })

  it('rejects a seed boundary that references a missing event', () => {
    const { repository } = harness()
    expect(() => repository.createSession({
      ...newFile(),
      session: { ...newFile().session, seedBoundaryId: 'evt_missing' as EventId },
    })).toThrow(/seed boundary/)
  })

  it('rejects registering an already-existing session', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    expect(() => repository.createSession(newFile())).toThrow(/already exists/)
  })

  it('rejects replacement blobs that collide with existing blobs', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('a'))
    const colliding = new Map<BlobId, Uint8Array>(replacementBlobs())
    colliding.set(blobId(0), encode('x'))
    expect(() => repository.compact(sessionId(), compactionInput(), colliding)).toThrow(/already exists/)
  })

  it('rejects an event counter at the safe integer ceiling', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: 'evt_sess_repo_9007199254740990' as EventId, blobId: blobId(0) },
    ])
    const blobs = new Map<BlobId, Uint8Array>([[blobId(0), eventEnvelope(0)]])
    repository.createSession(newFile(tree.entries(), blobs))
    // The next counter would exceed the safe integer range and produce an
    // unserializable nextEventCounter; the append must fail instead.
    expect(() => repository.append(sessionId(), surfaceAppend('next'))).toThrow(/safe integer range/)
  })

  it('rejects advancing the blob counter at the safe integer ceiling', () => {
    const { repository } = harness()
    const tree = SessionTree.fromEntries([
      { order: 0, eventId: eventId(0), blobId: 'blob_9007199254740991' as BlobId },
    ])
    const blobs = new Map<BlobId, Uint8Array>([['blob_9007199254740991' as BlobId, eventEnvelope(0)]])
    repository.createSession(newFile(tree.entries(), blobs))
    // The next id would exceed the safe integer range; the append must fail
    // instead of allocating an untrackable id that later appends overwrite.
    expect(() => repository.append(sessionId(), surfaceAppend('next'))).toThrow(/safe integer range/)
  })

  it('never reuses a blob id that a compaction dropped', () => {
    const { repository } = harness()
    let tree = SessionTree.empty()
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 4; i++) {
      tree = tree.append(eventId(i), blobId(i))
      blobs.set(blobId(i), eventEnvelope(i))
    }
    repository.createSession(newFile(tree.entries(), blobs))
    repository.compact(sessionId(), compactionInput(), replacementBlobs())
    // blob_0..blob_1 were dropped by the compaction; appending must allocate
    // above the highest id ever used instead of reusing them, so a consumer
    // holding blob_0 across generations still reads the immutable payload.
    repository.append(sessionId(), surfaceAppend('next'))
    const loaded = repository.loadSession(sessionId())
    const appended = loaded.entries[loaded.entries.length - 1]
    expect(appended?.blobId).toBe(blobId(104))
    expect(loaded.blobs.has(blobId(0))).toBe(false)
    expect(loaded.blobs.has(blobId(104))).toBe(true)
  })

  it('never reuses a shadowed EventId after compaction', () => {
    const { repository } = harness()
    let tree = SessionTree.empty()
    const blobs = new Map<BlobId, Uint8Array>()
    for (let i = 0; i < 10; i++) {
      tree = tree.append(eventId(i), blobId(i))
      blobs.set(blobId(i), eventEnvelope(i))
    }
    // An outlier id above a dense prefix, as an imported session can carry.
    tree = tree.append(eventId(50), blobId(50))
    blobs.set(blobId(50), eventEnvelope(50))
    repository.createSession(newFile(tree.entries(), blobs))

    const input: CompactionInput = {
      shadowedIds: [eventId(50)],
      checkpointEventId: eventId(53),
      checkpointBlobId: blobId(60),
      compactionId: 'compact_1' as CompactionId,
      startEventId: eventId(51),
      summaryEventId: eventId(52),
      endEventId: eventId(54),
      startBlobId: blobId(61),
      summaryBlobId: blobId(62),
      endBlobId: blobId(63),
      nextRevision: 'rev-1' as SessionRevision,
      nextEventCounter: 10,
    }
    const envelope = (type: string, marker: number): Uint8Array => {
      const body: Record<string, unknown> = { type, time: 1, data: { marker, compactionId: 'compact_1', turn: null } }
      if (type === 'user/message') {
        // The checkpoint is a surface user message: the message object lives
        // in `data` with the replace surfaceOp and shadowed-surface provenance
        // at the envelope top level; the single shadowed surface event (evt_50)
        // is seq 1 in the surface lineage.
        body.data = {
          id: 'm60',
          role: 'user',
          content: [{ type: 'text', text: 'checkpoint' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' },
          shadowedRange: { start: 1, end: 1 },
          shadowedSeqs: [1],
          shadowedTokenCount: 1,
          turn: null,
        }
        body.surfaceOp = { op: 'replace', start: 1, end: 1 }
        body.sourceEventSeqs = [1]
      }
      return encode(JSON.stringify(body))
    }
    const summary = {
      compactionId: 'compact_1',
      turn: null,
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedTokenCount: 1,
      provider: 'test',
      model: 'test',
      shadowedRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
    }
    repository.compact(sessionId(), input, new Map([
      [blobId(61), envelope('compaction/start', 61)],
      [blobId(62), envelope('compaction/summary', 62)],
      [blobId(60), envelope('user/message', 60)],
      [blobId(63), envelope('compaction/end', 63)],
    ].map(([id, bytes]) => [id, id === blobId(62)
      ? encode(JSON.stringify({ type: 'compaction/summary', time: 1, data: summary }))
      : bytes] as [BlobId, Uint8Array])))
    repository.append(sessionId(), encode('after'))
    const loaded = repository.loadSession(sessionId())
    const last = loaded.entries[loaded.entries.length - 1]
    // The shadowed evt_50 must not be regenerated; the counter advances past
    // every id the compaction recorded as shadowed.
    expect(last?.eventId).toBe(eventId(55))
  })

  it('reports whether a projection must be rebuilt after a compaction', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('first'))
    repository.append(sessionId(), surfaceAppend('second'))

    // Fold the two appended events into a projection, then shadow both with a compaction.
    const folded = repository.loadSession(sessionId()).entries.reduce<ProjectionState<number> | undefined>(
      (state, entry) => advanceProjection(state, entry.eventId, previous => (previous ?? 0) + 1),
      undefined,
    )
    const summary = repository.compact(sessionId(), compactionInput(), replacementBlobs())
    expect(summary).toBeDefined()

    expect(repository.projectionNeedsRebuild(sessionId(), folded, summary!)).toBe(true)
    expect(repository.projectionNeedsRebuild(sessionId(), undefined, summary!)).toBe(false)
  })

  it('reports a rebuild when the projection folded past the shadowed range', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('first'))
    repository.append(sessionId(), surfaceAppend('second'))
    repository.append(sessionId(), surfaceAppend('third'))

    // Fold all three events; the watermark is past the two-event shadowed range.
    const folded = repository.loadSession(sessionId()).entries.reduce<ProjectionState<number> | undefined>(
      (state, entry) => advanceProjection(state, entry.eventId, previous => (previous ?? 0) + 1),
      undefined,
    )
    const summary = repository.compact(sessionId(), compactionInput(), replacementBlobs())
    expect(summary).toBeDefined()
    expect(repository.projectionNeedsRebuild(sessionId(), folded, summary!)).toBe(true)
  })
})

  it('splits the persisted tree across many incremental appends and loads back', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    for (let i = 0; i < 30; i++) repository.append(sessionId(), surfaceAppend(`e${i}`))
    const loaded = repository.loadSession(sessionId())
    expect(loaded.entries).toHaveLength(30)
    expect(loaded.entries.every((entry, index) => index === 0 || entry.order > loaded.entries[index - 1]!.order)).toBe(true)
    expect(loaded.blobs.size).toBe(30)
    expect(loaded.session.nextEventCounter).toBe(30)
    expect(loaded.session.revision).toBe('rev-30')
    expect(loaded.session.usedEventBindings?.size).toBe(30)
    // The record carries a chained blob-map head whose chain is fully readable.
    expect(engine.record(sessionId())?.blobMapPage).toBeDefined()
  })

  it('rejects an incremental append whose counter does not advance', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    const record = engine.record(sessionId())!
    expect(() => engine.commitAppend(
      sessionId(),
      'evt_sess_repo_0' as EventId,
      'blob_0' as BlobId,
      record.nextEventCounter, // not advanced
      0,
      surfaceAppend('x'),
      record.revision,
    )).toThrow(/must advance the stored counter/)
  })

  it('rejects an incremental append whose blob watermark does not advance', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    const record = engine.record(sessionId())!
    expect(() => engine.commitAppend(
      sessionId(),
      'evt_sess_repo_0' as EventId,
      'blob_0' as BlobId,
      record.nextEventCounter + 1,
      -1, // not advanced
      surfaceAppend('x'),
      record.revision,
    )).toThrow(/must advance the stored watermark/)
  })

  it('treats a stale incremental append as a CAS miss', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    const record = engine.record(sessionId())!
    const result = engine.commitAppend(
      sessionId(),
      'evt_sess_repo_0' as EventId,
      'blob_0' as BlobId,
      record.nextEventCounter + 1,
      0,
      surfaceAppend('x'),
      'rev-99' as SessionRevision, // stale
    )
    expect(result).toBeUndefined()
    expect(repository.loadSession(sessionId()).entries).toHaveLength(0)
  })

  it('treats an incremental append that rebinds a used EventId as a CAS miss', () => {
    const { repository, engine } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('first'))
    const record = engine.record(sessionId())!
    // evt_sess_repo_0 is already bound to blob_0; committing the same id
    // under a different blob fails the binding-append check and returns a
    // CAS miss instead of rebinding history.
    const result = engine.commitAppend(
      sessionId(),
      'evt_sess_repo_0' as EventId,
      'blob_9' as BlobId,
      record.nextEventCounter + 1,
      9,
      surfaceAppend('x'),
      record.revision,
    )
    expect(result).toBeUndefined()
    expect(repository.loadSession(sessionId()).session.usedEventBindings?.get('evt_sess_repo_0' as EventId)).toBe('blob_0' as BlobId)
  })

  it('appends to a forked child without colliding with inherited blob ids', () => {
    const { repository } = harness()
    repository.createSession(newFile())
    repository.append(sessionId(), surfaceAppend('a'))
    repository.append(sessionId(), surfaceAppend('b'))
    repository.append(sessionId(), surfaceAppend('c'))
    const child = repository.fork(sessionId(), eventId(1), 'sess_forkchild' as SessionId)
    // The child inherits blobs blob_0..1; the append must mint blob_3 (above
    // the inherited watermark) instead of colliding with blob_0.
    repository.append('sess_forkchild' as SessionId, surfaceAppend('child'))
    const loaded = repository.loadSession('sess_forkchild' as SessionId)
    expect(loaded.entries).toHaveLength(3)
    expect(loaded.entries[2]?.eventId).toBe('evt_sess_forkchild_3' as EventId)
    expect(loaded.entries[2]?.blobId).toBe('blob_3' as BlobId)
    expect(loaded.session.blobIdWatermark).toBe(3)
    // The parent keeps its own blobs untouched.
    expect(decode(repository.loadSession(sessionId()).blobs.get(blobId(0)))).toContain('a')
  })

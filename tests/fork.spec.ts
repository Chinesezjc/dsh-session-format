import { describe, expect, it } from 'vitest'
import { SessionTree } from '../src/btree.ts'
import { exportSessionFile, importSessionFile, type SessionFile } from '../src/file.ts'
import { forkSessionFile } from '../src/fork.ts'
import type {
  BlobId,
  CompactionId,
  CompactionSummary,
  EventId,
  PageId,
  ReferenceRecord,
  SessionId,
  SessionRevision,
  StoredSessionRecord,
} from '../src/index.ts'

function eventId(n: number): EventId {
  return `evt_sess_parent_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

function childRecord(): { rootPage: PageId; revision: SessionRevision; nextEventCounter: number } {
  return { rootPage: 'page_sess_child' as PageId, revision: 'rev-0' as SessionRevision, nextEventCounter: 10 }
}

function makeFile(options: {
  readonly seedBoundaryId?: EventId
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly references?: ReferenceRecord[]
  readonly compacted?: CompactionSummary[]
  readonly pagePointers?: boolean
} = {}): SessionFile {
  let tree = SessionTree.empty()
  const blobs = new Map<BlobId, Uint8Array>()
  for (let i = 0; i < 6; i++) {
    const id = eventId(i)
    const blob = blobId(i)
    tree = tree.append(id, blob)
    blobs.set(blob, new TextEncoder().encode(`event-${i}`))
  }
  const session: StoredSessionRecord = {
    sessionId: 'sess_parent' as SessionId,
    formatVersion: 1,
    nextEventCounter: 10,
    rootPage: 'page_root' as PageId,
    revision: 'rev-1' as SessionRevision,
    ...(options.seedBoundaryId === undefined ? {} : { seedBoundaryId: options.seedBoundaryId }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    ...(options.pagePointers === true
      ? { blobMapPage: 'page_blobmap' as PageId, referencesPage: 'page_references' as PageId }
      : {}),
    backups: [],
  }
  return {
    session,
    entries: tree.entries(),
    blobs,
    references: options.references ?? [],
    compacted: options.compacted ?? [],
  }
}

describe('forkSessionFile', () => {
  it('inherits the prefix including the boundary and keeps parent EventIds', () => {
    const child = forkSessionFile(makeFile(), eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.entries.map(entry => entry.eventId)).toEqual([
      eventId(0),
      eventId(1),
      eventId(2),
      eventId(3),
    ])
    expect(child.session.sessionId).toBe('sess_child')
    expect(child.session.revision).toBe('rev-0')
    expect(child.blobs.size).toBe(4)
  })

  it('sets the child seed boundary to the fork point even past a parent boundary', () => {
    const child = forkSessionFile(makeFile({ seedBoundaryId: eventId(3) }), eventId(5), 'sess_child' as SessionId, childRecord())
    expect(child.session.seedBoundaryId).toBe(eventId(5))
  })

  it('sets the child seed boundary to the fork point before a parent boundary', () => {
    const child = forkSessionFile(makeFile({ seedBoundaryId: eventId(3) }), eventId(1), 'sess_child' as SessionId, childRecord())
    expect(child.session.seedBoundaryId).toBe(eventId(1))
  })

  it('sets the child seed boundary when the parent has none', () => {
    const child = forkSessionFile(makeFile(), eventId(1), 'sess_child' as SessionId, childRecord())
    expect(child.session.seedBoundaryId).toBe(eventId(1))
  })

  it('inherits only references whose source and targets are inherited', () => {
    const references: ReferenceRecord[] = [
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(2)] },
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(4)] },
      { fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: [eventId(1)] },
    ]
    const child = forkSessionFile(makeFile({ references }), eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.references).toEqual([
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(2)] },
    ])
  })

  it('inherits only compaction summaries whose checkpoint event is inherited', () => {
    const compacted: CompactionSummary[] = [
      {
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(0), endId: eventId(1) },
        shadowedIds: [eventId(0), eventId(1)],
        shadowedSeqRange: { start: 0, end: 1 },
        shadowedSeqs: [0, 1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
      {
        compactionId: 'compact_2' as CompactionId,
        checkpointEventId: eventId(8),
        markerEventIds: { startEventId: eventId(4), summaryEventId: eventId(5), endEventId: eventId(6) },
        shadowedRange: { startId: eventId(4), endId: eventId(5) },
        shadowedIds: [eventId(4), eventId(5)],
        shadowedSeqRange: { start: 0, end: 1 },
        shadowedSeqs: [4, 5],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
    ]
    const child = forkSessionFile(makeFile({ compacted }), eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.compacted).toEqual([compacted[0]])
  })

  it('does not inherit parent page pointers', () => {
    const child = forkSessionFile(makeFile({ pagePointers: true }), eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.blobMapPage).toBeUndefined()
    expect(child.session.referencesPage).toBeUndefined()
    expect(child.session.rootPage).toBe('page_sess_child')
    expect(child.session.revision).toBe('rev-0')
  })
})

describe('export and import', () => {
  it('round-trips a self-contained archive', () => {
    const file = makeFile()
    const imported = importSessionFile(exportSessionFile(file))
    expect(imported.entries).toEqual(file.entries)
    expect(imported.blobs.size).toBe(file.blobs.size)
  })

  it('rejects a child session id equal to the parent id', () => {
    expect(() => forkSessionFile(makeFile(), eventId(3), 'sess_parent' as SessionId, childRecord())).toThrow(
      'child session id must differ from the parent session id',
    )
  })

  it('rejects a fork boundary that cuts a compaction bracket in half', () => {
    // The compacted summary's start marker is evt_0; forking at evt_1 inherits
    // the start/summary markers but not the checkpoint, so the bracket is cut.
    const file = makeFile({
      compacted: [{
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: eventId(4),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(5) },
        shadowedRange: { startId: eventId(2), endId: eventId(3) },
        shadowedIds: [eventId(2), eventId(3)],
        shadowedSeqRange: { start: 2, end: 3 },
        shadowedSeqs: [2, 3],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }],
    })
    expect(() => forkSessionFile(file, eventId(2), 'sess_child' as SessionId, { rootPage: 'page_root' as PageId, revision: 'rev-1' as SessionRevision, nextEventCounter: 10 })).toThrow(
      'fork boundary must not cut a compaction bracket in half',
    )
  })

  it('rejects a fork boundary that cuts an unclaimed compaction bracket in half', () => {
    // A migrated file carries its compaction markers without a side-table
    // record; forking between the unclaimed start and end would inherit the
    // start without the end, leaving a half-open bracket in the child.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 3 },
      sourceEventSeqs: [2, 3],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => forkSessionFile({ ...file, blobs }, eventId(2), 'sess_child' as SessionId, childRecord())).toThrow(
      'fork boundary must not cut a compaction bracket in half',
    )
  })

  it('allows a child counter below the parent counter', () => {
    // The counter is per-session: the child's EventId prefix is its own, so
    // its counter is independent of the parent's high-water.
    const child = forkSessionFile(makeFile(), eventId(3), 'sess_child' as SessionId, { rootPage: 'page_root' as PageId, revision: 'rev-1' as SessionRevision, nextEventCounter: 1 })
    expect(child.session.nextEventCounter).toBe(1)
  })

  it('tolerates non-record JSON blobs when scanning for compaction brackets', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode('[1, 2]'))
    const child = forkSessionFile({ ...file, blobs }, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.entries.map(entry => entry.eventId)).toEqual([eventId(0), eventId(1), eventId(2), eventId(3)])
  })

  it('tolerates an orphaned unclaimed compaction/end when scanning for brackets', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 0, data: { compactionId: 'compact_1', turn: null, error: { kind: 'failed' } } })))
    const child = forkSessionFile({ ...file, blobs }, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.sessionId).toBe('sess_child')
  })

  it('accepts a fork boundary after a completed unclaimed transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, data: { compactionId: 'compact_1', turn: null, error: { kind: 'failed' } } })))
    const child = forkSessionFile({ ...file, blobs }, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.entries.map(entry => entry.eventId)).toEqual([eventId(0), eventId(1), eventId(2), eventId(3)])
  })

  it('rejects a fork at an unknown EventId', () => {
    const file = makeFile()
    expect(() => forkSessionFile(file, 'evt_ghost' as EventId, 'sess_child' as SessionId, { rootPage: 'page_root' as PageId, revision: 'rev-1' as SessionRevision, nextEventCounter: 10 })).toThrow(
      'cannot fork at an unknown EventId',
    )
  })

  it('rejects a negative nextEventCounter', () => {
    const file = makeFile()
    expect(() => forkSessionFile(file, eventId(3), 'sess_child' as SessionId, { rootPage: 'page_root' as PageId, revision: 'rev-1' as SessionRevision, nextEventCounter: -1 })).toThrow(
      'fork record nextEventCounter must be a non-negative safe integer',
    )
  })

  it('rejects a fork boundary inside an open turn', () => {
    // evt_2 is a turn/start without its closing turn/end; forking at it would
    // resume the half-open turn in the child, which the store refuses live.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 2, data: { turn: 1 } })))
    expect(() => forkSessionFile({ ...file, blobs }, eventId(2), 'sess_child' as SessionId, childRecord())).toThrow(
      'fork boundary must not end inside an open turn',
    )
  })

  it('rejects a fork boundary after a turn/end that mismatches the open turn', () => {
    // Core's invariant rejects a turn/end whose id does not name the open
    // turn, so the mismatched end never closes the turn and forking inside it
    // would resume a turn the runtime cannot replay.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 2, data: { turn: 2, reason: { kind: 'success' } } })))
    expect(() => forkSessionFile({ ...file, blobs }, eventId(2), 'sess_child' as SessionId, childRecord())).toThrow(
      'fork boundary must not end inside an open turn',
    )
  })

  it('tolerates a turn boundary whose data is not a record when scanning turns', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: 5 })))
    const child = forkSessionFile({ ...file, blobs }, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.sessionId).toBe('sess_child')
  })

  it('accepts a fork boundary after a closed turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'success' } } })))
    const child = forkSessionFile({ ...file, blobs }, eventId(2), 'sess_child' as SessionId, childRecord())
    expect(child.entries.map(entry => entry.eventId)).toEqual([eventId(0), eventId(1), eventId(2)])
  })

  it('rejects a fork boundary inside an outer turn whose inner turn already closed', () => {
    // turn 1 opens, turn 2 opens and closes, then the fork lands before
    // turn 1 closes: the last boundary is a turn/end but turn 1 is still open.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 2, data: { turn: 2 } })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 3, data: { turn: 2, reason: { kind: 'success' } } })))
    expect(() => forkSessionFile({ ...file, blobs }, eventId(3), 'sess_child' as SessionId, childRecord())).toThrow(
      'fork boundary must not end inside an open turn',
    )
  })

  it('rejects a fork boundary after an orphaned turn/end masks an open turn', () => {
    // An orphaned turn/end (no matching start in the prefix) followed by a
    // turn/start: a depth counter would go negative then back to zero and
    // miss the open turn; the stack treats the orphan pop as a no-op.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 1, data: { turn: 9, reason: { kind: 'success' } } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 2, data: { turn: 1 } })))
    expect(() => forkSessionFile({ ...file, blobs }, eventId(2), 'sess_child' as SessionId, childRecord())).toThrow(
      'fork boundary must not end inside an open turn',
    )
  })

  it('inherits the parent cwd and records the parent session id', () => {
    const file = makeFile({ cwd: '/tmp/work' })
    const child = forkSessionFile(file, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.cwd).toBe('/tmp/work')
    expect(child.session.parentSession).toBe('sess_parent')
  })

  it('inherits the parent origin, delegation depth, and agent preset', () => {
    const file = makeFile({ origin: 'subagent', delegationDepth: 2, agentPreset: 'headless' })
    const child = forkSessionFile(file, eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.origin).toBe('subagent')
    expect(child.session.delegationDepth).toBe(2)
    expect(child.session.agentPreset).toBe('headless')
  })

  it('leaves delegation fields unset when the parent has none', () => {
    const child = forkSessionFile(makeFile(), eventId(3), 'sess_child' as SessionId, childRecord())
    expect(child.session.origin).toBeUndefined()
    expect(child.session.delegationDepth).toBeUndefined()
    expect(child.session.agentPreset).toBeUndefined()
  })
})

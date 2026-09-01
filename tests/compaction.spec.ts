import { describe, expect, it } from 'vitest'
import { SessionTree } from '../src/btree.ts'
import { performCompaction, type CompactionInput } from '../src/compaction.ts'
import { deserializeSessionFile, serializeSessionFile, type SessionFile } from '../src/file.ts'
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

function sessionId(): SessionId {
  return 'sess_test' as SessionId
}

function eventId(n: number): EventId {
  return `evt_sess_test_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

function makeFile(
  references: ReferenceRecord[] = [],
  seedBoundaryId?: EventId,
  options: { readonly compacted?: CompactionSummary[]; readonly pagePointers?: boolean } = {},
): SessionFile {
  let tree = SessionTree.empty()
  const blobs = new Map<BlobId, Uint8Array>()
  for (let i = 0; i < 10; i++) {
    const id = eventId(i)
    const blob = blobId(i)
    tree = tree.append(id, blob)
    const payload = i === 3
      ? JSON.stringify({ type: 'turn/finish', time: i, data: { duration: i } })
      : i >= 2 && i <= 5
        ? JSON.stringify({ type: 'user/message', time: i, data: { text: `event-${i}` }, surfaceOp: 'append' })
        : `event-${i}`
    blobs.set(blob, new TextEncoder().encode(payload))
  }
  // The four replacement blobs are supplied by the caller before compaction
  // runs, encoded as full event blobs.
  blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } }, surfaceOp: { op: 'replace', start: 2, end: 5 }, sourceEventSeqs: [2, 4, 5] })))
  blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
  blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
    type: 'compaction/summary',
    time: 9,
    data: { compactionId: 'compact_1', summary: [{ type: 'text', text: 'summarized' }], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 42, provider: 'deepseek', model: 'deepseek-chat' },
  })))
  blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null } })))
  const session: StoredSessionRecord = {
    sessionId: sessionId(),
    formatVersion: 1,
    nextEventCounter: 10,
    rootPage: 'page_root' as PageId,
    revision: 'rev-1' as SessionRevision,
    ...(seedBoundaryId === undefined ? {} : { seedBoundaryId }),
    ...(options.pagePointers === true
      ? { blobMapPage: 'page_blobmap' as PageId, referencesPage: 'page_references' as PageId }
      : {}),
    backups: [],
  }
  return { session, entries: tree.entries(), blobs, references, compacted: options.compacted ?? [] }
}

function input(): CompactionInput {
  return {
    shadowedIds: [eventId(2), eventId(4), eventId(5)],
    checkpointEventId: eventId(100),
    checkpointBlobId: blobId(100),
    compactionId: 'compact_1' as CompactionId,
    startEventId: eventId(101),
    summaryEventId: eventId(102),
    endEventId: eventId(103),
    startBlobId: blobId(101),
    summaryBlobId: blobId(102),
    endBlobId: blobId(103),
    nextRevision: 'rev-2' as SessionRevision,
    nextEventCounter: 200,
  }
}

describe('performCompaction', () => {
  it('removes the shadowed events, records the summary, and advances the revision', () => {
    const next = performCompaction(makeFile(), input())
    const ids = next.entries.map(entry => entry.eventId)
    expect(ids).toEqual([
      eventId(0),
      eventId(1),
      eventId(101),
      eventId(102),
      eventId(100),
      eventId(103),
      eventId(3),
      eventId(6),
      eventId(7),
      eventId(8),
      eventId(9),
    ])
    expect(next.compacted).toHaveLength(1)
    expect(next.compacted[0]).toEqual({
      compactionId: 'compact_1',
      checkpointEventId: eventId(100),
      markerEventIds: {
        startEventId: eventId(101),
        summaryEventId: eventId(102),
        endEventId: eventId(103),
      },
      shadowedRange: { startId: eventId(2), endId: eventId(5) },
      shadowedIds: [eventId(2), eventId(4), eventId(5)],
      shadowedSeqRange: { start: 2, end: 5 },
      shadowedSeqs: [2, 4, 5],
      summary: [{ type: 'text', text: 'summarized' }],
      shadowedTokenCount: 42,
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(next.session.revision).toBe('rev-2')
    expect(next.session.backups).toEqual([])
  })

  it('keeps log-only events between shadowed surface events', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [{ type: 'text', text: 'summarized' }], shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 4], shadowedTokenCount: 42, provider: 'deepseek', model: 'deepseek-chat' },
    })))
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 4 },
      sourceEventSeqs: [2, 4],
    })))
    const next = performCompaction({ ...file, blobs }, { ...input(), shadowedIds: [eventId(2), eventId(4)] })
    expect(next.entries.map(entry => entry.eventId)).toEqual([
      eventId(0),
      eventId(1),
      eventId(101),
      eventId(102),
      eventId(100),
      eventId(103),
      eventId(3),
      eventId(5),
      eventId(6),
      eventId(7),
      eventId(8),
      eventId(9),
    ])
    expect(next.compacted[0]!.shadowedIds).toEqual([eventId(2), eventId(4)])
  })

  it('drops references sourced by a shadowed event', () => {
    const file = makeFile([
      { fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: [eventId(2), eventId(3)] },
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(2)] },
    ])
    const next = performCompaction(file, input())
    expect(next.references).toEqual([
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(100)] },
    ])
  })

  it('deduplicates redirected reference targets', () => {
    const file = makeFile([
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(2), eventId(3), eventId(8)] },
    ])
    const next = performCompaction(file, input())
    expect(next.references).toEqual([
      { fromEventId: eventId(1), refName: 'sourceEventIds', toEventIds: [eventId(100), eventId(3), eventId(8)] },
    ])
  })

  it('removes blobs referenced only by shadowed events', () => {
    const next = performCompaction(makeFile(), input())
    expect(next.blobs.has(blobId(2))).toBe(false)
    expect(next.blobs.has(blobId(5))).toBe(false)
    expect(next.blobs.has(blobId(0))).toBe(true)
    expect(next.blobs.has(blobId(3))).toBe(true)
    expect(next.blobs.has(blobId(6))).toBe(true)
    expect(Array.from(next.blobs.get(blobId(100))!)).toEqual(
      Array.from(new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } }, surfaceOp: { op: 'replace', start: 2, end: 5 }, sourceEventSeqs: [2, 4, 5] }))),
    )
    expect(Array.from(next.blobs.get(blobId(101))!)).toEqual(
      Array.from(new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } }))),
    )
    expect(next.blobs.size).toBe(11)
  })

  it('rejects an empty shadowed set', () => {
    expect(() => performCompaction(makeFile(), { ...input(), shadowedIds: [] })).toThrow(
      'compaction shadowedIds must not be empty',
    )
  })

  it('rejects shadowed ids that are not present', () => {
    const bad = { ...input(), shadowedIds: [eventId(2), eventId(99)] }
    expect(() => performCompaction(makeFile(), bad)).toThrow('compaction shadowedIds must name present EventIds')
  })

  it('rejects duplicate shadowed ids', () => {
    const bad = { ...input(), shadowedIds: [eventId(2), eventId(2)] }
    expect(() => performCompaction(makeFile(), bad)).toThrow('compaction shadowedIds must not contain duplicates')
  })

  it('rejects a range that cuts an earlier transaction in half', () => {
    const once = performCompaction(makeFile(), input())
    const bad = {
      ...input(),
      shadowedIds: [eventId(100), eventId(101)],
      checkpointEventId: eventId(200),
      checkpointBlobId: blobId(200),
      startEventId: eventId(201),
      summaryEventId: eventId(202),
      endEventId: eventId(203),
      startBlobId: blobId(201),
      summaryBlobId: blobId(202),
      endBlobId: blobId(203),
      compactionId: 'compact_2' as CompactionId,
      nextRevision: 'rev-3' as SessionRevision,
      nextEventCounter: 300,
    }
    const blobs = new Map(once.blobs)
    for (const [id, label] of [[blobId(200), 'checkpoint-2'], [blobId(201), 'start-2'], [blobId(202), 'summary-2'], [blobId(203), 'end-2']] as const) {
      blobs.set(id, new TextEncoder().encode(label))
    }
    expect(() => performCompaction({ ...once, blobs }, bad)).toThrow(
      'compaction range must not cut an earlier transaction in half',
    )
  })

  it('rejects a range that cuts an unclaimed transaction in half', () => {
    // A migrated file carries its transaction without a side-table record;
    // shadowing only its checkpoint would leave a nested transaction, so the
    // entry-stream bracket scan must apply the same indivisibility rule.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 4, 5],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => performCompaction({ ...file, blobs }, { ...input(), shadowedIds: [eventId(2)] })).toThrow(
      'compaction range must not cut an earlier transaction in half',
    )
  })

  it('rejects replacement EventIds that collide with existing events', () => {
    const bad = { ...input(), startEventId: eventId(0) }
    expect(() => performCompaction(makeFile(), bad)).toThrow(
      'replacement EventIds must be unique and not collide with existing or retired events',
    )
  })

  it('rejects replacement EventIds that are not pairwise unique', () => {
    const bad = { ...input(), summaryEventId: input().startEventId }
    expect(() => performCompaction(makeFile(), bad)).toThrow(
      'replacement EventIds must be unique and not collide with existing or retired events',
    )
  })

  it('rejects replacement EventIds that reuse a retired shadowed id', () => {
    const compacted = [{
      compactionId: 'compact_0' as CompactionId,
      checkpointEventId: eventId(50),
      markerEventIds: {
        startEventId: eventId(51),
        summaryEventId: eventId(52),
        endEventId: eventId(53),
      },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const bad = { ...input(), startEventId: eventId(20) }
    expect(() => performCompaction(makeFile([], undefined, { compacted }), bad)).toThrow(
      'replacement EventIds must be unique and not collide with existing or retired events',
    )
  })

  it('rejects a missing replacement blob instead of fabricating one', () => {
    const bad = { ...input(), checkpointBlobId: blobId(999) }
    expect(() => performCompaction(makeFile(), bad)).toThrow(
      'replacement BlobIds must be pairwise distinct and already present in the file',
    )
  })

  it('rejects replacement BlobIds that are not pairwise distinct', () => {
    const bad = { ...input(), summaryBlobId: input().startBlobId }
    expect(() => performCompaction(makeFile(), bad)).toThrow(
      'replacement BlobIds must be pairwise distinct and already present in the file',
    )
  })

  it('rejects replacement BlobIds referenced by existing events', () => {
    const bad = { ...input(), startBlobId: blobId(0) }
    expect(() => performCompaction(makeFile(), bad)).toThrow(
      'replacement BlobIds must not be referenced by existing events',
    )
  })

  it('rejects a replacement blob that is not a JSON event envelope', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode('not-json'))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a JSON event envelope',
    )
  })

  it('rejects a replacement blob whose envelope lacks the time field', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', data: {} })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a { type, time, data } event envelope',
    )
  })

  it('rejects a replacement blob whose type does not match its marker role', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: {} })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a compaction/start event',
    )
  })

  it('rejects a replacement blob belonging to another compaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_9' } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must belong to compaction compact_1',
    )
  })

  it('rejects a summary blob that is not a JSON object envelope', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode('[1,2]'))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must be a { type, time, data } event envelope',
    )
  })

  it('rejects a summary blob whose data is not an object', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({ type: 'compaction/summary', time: 9, data: 5 })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must belong to compaction compact_1',
    )
  })

  it('rejects a summary blob whose data lacks a content block array', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9, data: { compactionId: 'compact_1', summary: 'nope', shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.summary must be a content block array',
    )
  })

  it('rejects a summary blob whose content overflows to Infinity', () => {
    // A JSON literal 1e400 in a content block parses to Infinity, which
    // JSON.stringify would rewrite to null and break the round-trip.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    const encoded = JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [{ type: 'image', attachment: { width: 1e400 } }], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    }).replace('"width":null', '"width":1e400')
    blobs.set(blobId(102), new TextEncoder().encode(encoded))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.summary must be a content block array',
    )
  })

  it('rejects a summary blob whose content carries negative zero', () => {
    // JSON.stringify rewrites -0 to 0, silently losing the sign.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    const encoded = JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [{ type: 'image', attachment: { width: -0 } }], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    }).replace('"width":0', '"width":-0')
    blobs.set(blobId(102), new TextEncoder().encode(encoded))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.summary must be a content block array',
    )
  })

  it('rejects a summary blob whose content block array has a non-record entry', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9, data: { compactionId: 'compact_1', summary: [5], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.summary must be a content block array',
    )
  })

  it('rejects a summary blob whose data lacks a token count', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9, data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 'x', provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.shadowedTokenCount must be a non-negative safe integer',
    )
  })

  it('rejects a summary blob whose data lacks provider and model', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9, data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 5, model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.provider and data.model must be strings',
    )
  })

  it('rejects a summary blob with a malformed rawOutput', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', rawOutput: 'nope' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.rawOutput must be a content block array',
    )
  })

  it('rejects a summary blob whose rawOutput array has a non-record entry', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', rawOutput: [5] },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.rawOutput must be a content block array',
    )
  })

  it('carries a valid rawOutput into the summary record', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', rawOutput: [{ type: 'text', text: 'raw' }] },
    })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.compacted[0]!.rawOutput).toEqual([{ type: 'text', text: 'raw' }])
  })

  it('rejects a missing summary blob', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.delete(blobId(102))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement BlobIds must be pairwise distinct and already present in the file',
    )
  })

  it('redirects a seed boundary that falls inside the shadowed set', () => {
    const next = performCompaction(makeFile([], eventId(4)), input())
    expect(next.session.seedBoundaryId).toBe(eventId(100))
  })

  it('keeps a seed boundary outside the shadowed set', () => {
    const next = performCompaction(makeFile([], eventId(1)), input())
    expect(next.session.seedBoundaryId).toBe(eventId(1))
  })

  it('drops parent page pointers from the compacted record', () => {
    const next = performCompaction(makeFile([], undefined, { pagePointers: true }), input())
    expect(next.session.blobMapPage).toBeUndefined()
    expect(next.session.referencesPage).toBeUndefined()
    expect(next.session.rootPage).toBe('page_root')
  })

  it('assigns non-colliding orders and folds retired ids when a transaction is replaced whole', () => {
    const once = performCompaction(makeFile(), input())
    const blobs = new Map(once.blobs)
    blobs.set(blobId(200), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { id: 'm200', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_2' } }, surfaceOp: { op: 'replace', start: 100, end: 100 }, sourceEventSeqs: [100] })))
    blobs.set(blobId(201), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(202), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_2', summary: [], shadowedRange: { start: 100, end: 100 }, shadowedSeqs: [100], shadowedTokenCount: 0, provider: 'deepseek', model: 'deepseek-chat' },
    })))
    blobs.set(blobId(203), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    const again = performCompaction({ ...once, blobs }, {
      ...input(),
      // The whole first transaction bracket is shadowed as one unit.
      shadowedIds: [eventId(101), eventId(102), eventId(100), eventId(103)],
      checkpointEventId: eventId(200),
      checkpointBlobId: blobId(200),
      startEventId: eventId(201),
      summaryEventId: eventId(202),
      endEventId: eventId(203),
      startBlobId: blobId(201),
      summaryBlobId: blobId(202),
      endBlobId: blobId(203),
      compactionId: 'compact_2' as CompactionId,
      nextRevision: 'rev-3' as SessionRevision,
      nextEventCounter: 300,
    })
    const orders = again.entries.map(entry => entry.order)
    const unique = new Set(orders)
    expect(unique.size).toBe(orders.length)
    expect([...unique].sort((a, b) => a - b)).toEqual(orders)
    // The first compaction's summary is dropped because its checkpoint event
    // is shadowed again, but its retired ids stay in the new summary.
    expect(again.compacted.map(summary => summary.compactionId)).toEqual(['compact_2'])
    expect(again.compacted[0]!.shadowedIds).toEqual(
      expect.arrayContaining([eventId(2), eventId(4), eventId(5)]),
    )
    // A third compaction must still reject reusing an EventId retired by the
    // first compaction.
    const blobs3 = new Map(again.blobs)
    blobs3.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 0, data: { text: 'x' }, surfaceOp: 'append' })))
    expect(() => performCompaction({ ...again, blobs: blobs3 }, {
      ...input(),
      shadowedIds: [eventId(0)],
      startEventId: eventId(4),
      nextEventCounter: 400,
    })).toThrow('replacement EventIds must be unique and not collide with existing or retired events')
  })

  it('rejects a summary blob with a non-string sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 5 } })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', sourceCommandId: 5 },
    })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 5 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction marker blobs must carry a non-empty string sourceCommandId',
    )
  })

  it('rejects a summary blob with a non-number maxTokens', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', maxTokens: 'x' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.maxTokens must be a non-negative safe integer',
    )
  })

  it('rejects a summary blob whose maxTokens overflows to Infinity', () => {
    // JSON.parse of the literal '1e400' yields Infinity, which JSON.stringify
    // would rewrite to null and break the file round-trip.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    }).replace('"shadowedTokenCount":0', '"shadowedTokenCount":0,"maxTokens":1e400')))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.maxTokens must be a non-negative safe integer',
    )
  })

  it('shadows a whole unclaimed transaction', () => {
    // A migrated file carries its transaction without a side-table record;
    // shadowing the entire bracket (start/summary/checkpoint/end) must be
    // allowed, with the log-only markers exempt from the surface check.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 2 },
      sourceEventSeqs: [2],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_2' } },
      surfaceOp: { op: 'replace', start: 2, end: 2 },
      sourceEventSeqs: [2],
    })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_2', summary: [], shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    const next = performCompaction({ ...file, blobs }, {
      shadowedIds: [eventId(0), eventId(1), eventId(2), eventId(3)],
      checkpointEventId: eventId(100),
      checkpointBlobId: blobId(100),
      compactionId: 'compact_2' as CompactionId,
      startEventId: eventId(101),
      summaryEventId: eventId(102),
      endEventId: eventId(103),
      startBlobId: blobId(101),
      summaryBlobId: blobId(102),
      endBlobId: blobId(103),
      nextRevision: 'rev-2' as SessionRevision,
      nextEventCounter: 200,
    })
    expect(next.compacted[0]!.shadowedIds).toEqual([eventId(0), eventId(1), eventId(2), eventId(3)])
  })

  it('rejects a summary blob whose usage overflows to Infinity', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    const encoded = JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', usage: { inputTokens: 1e400, outputTokens: 1 } },
    }).replace('"inputTokens":null', '"inputTokens":1e400')
    blobs.set(blobId(102), new TextEncoder().encode(encoded))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.usage must be a token usage record',
    )
  })

  it('derives range endpoints from non-ascending shadowedIds order', () => {
    // The range endpoints come from rank min/max, so the caller's shadowedIds
    // order must not matter; a descending order exercises both reduce branches.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 4, end: 2 },
      sourceEventSeqs: [4, 2],
    })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 4, end: 2 }, shadowedSeqs: [4, 2], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    const next = performCompaction({ ...file, blobs }, {
      ...input(),
      shadowedIds: [eventId(4), eventId(2)],
    })
    expect(next.compacted[0]!.shadowedRange).toEqual({ startId: eventId(2), endId: eventId(4) })
  })

  it('rejects a summary blob with a non-object usage', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', usage: 'x' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.usage must be a token usage record',
    )
  })

  it('rejects a summary blob with a non-boolean llmStreamCall', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', llmStreamCall: 'yes' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.llmStreamCall must be true or absent',
    )
  })

  it('rejects an llmStreamCall summary without rawOutput', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', llmStreamCall: true },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.rawOutput is required when llmStreamCall is true',
    )
  })

  it('carries the summary discriminants into the record', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: 'cmd_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 4, 5],
    })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_1' } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_1' } })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: {
        compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5],
        shadowedTokenCount: 0, provider: 'p', model: 'm',
        sourceCommandId: 'cmd_1', maxTokens: 100, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, llmStreamCall: true,
        rawOutput: [{ type: 'text', text: 'raw' }],
      },
    })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.compacted[0]).toMatchObject({
      sourceCommandId: 'cmd_1',
      maxTokens: 100,
      usage: { totalTokens: 10 },
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'raw' }],
    })
  })

  it('rejects a surviving entry whose blob is missing from the file', () => {
    const file = makeFile()
    const broken = { ...file, blobs: new Map(file.blobs) }
    broken.blobs.delete(blobId(0))
    expect(() => performCompaction(broken, input())).toThrow('references blob blob_0 that is not in the file')
  })

  it('rejects a start marker without a turn field', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1' } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must carry a numeric or null turn',
    )
  })

  it('rejects a start marker with a non-numeric turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 'bad' } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must carry a numeric or null turn',
    )
  })

  it('rejects a checkpoint whose data is not an object', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: 5, surfaceOp: { op: 'replace', start: 2, end: 5 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a summary marker without a numeric shadowedRange', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: 'x', shadowedSeqs: [], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must carry a numeric shadowedRange',
    )
  })

  it('rejects a summary marker without a numeric shadowedSeqs array', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: 'x', shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must carry a shadowedSeqs array spanning its shadowedRange',
    )
  })

  it('rejects a shadowed event that is not a surface event', () => {
    expect(() => performCompaction(makeFile(), { ...input(), shadowedIds: [eventId(0)] })).toThrow(
      'shadowed event evt_sess_test_0 must be a surface event with a surfaceOp marker',
    )
  })

  it('rejects a checkpoint blob without a surfaceOp marker', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { checkpoint: true, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a shadowed event whose blob is missing from the file', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.delete(blobId(2))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'shadowed event evt_sess_test_2 must be a surface event with a surfaceOp marker',
    )
  })

  it('rejects a checkpoint blob that is not JSON', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode('not-json'))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_100 must be a JSON event envelope',
    )
  })

  it('rejects start and end markers with different turns', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 5 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/start and compaction/end markers must carry the same turn',
    )
  })

  it('rejects marker blobs with inconsistent sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_1' } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction marker blobs must carry a consistent sourceCommandId',
    )
  })

  it('rejects a checkpoint whose data is not a record', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: 5 })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a shadowed range that leaves a live surface event uncovered', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 3, data: { text: 'x' }, surfaceOp: 'append' })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 4], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 4 },
      sourceEventSeqs: [2, 4],
    })))
    expect(() => performCompaction({ ...file, blobs }, { ...input(), shadowedIds: [eventId(2), eventId(4)] })).toThrow(
      'shadowed range must cover the live surface event evt_sess_test_3',
    )
  })

  it('carries the session createdAt into the compacted record', () => {
    const file = makeFile()
    const session = { ...file.session, createdAt: 12345 }
    const next = performCompaction({ ...file, session }, input())
    expect(next.session.createdAt).toBe(12345)
  })

  it('treats an interval candidate with a non-JSON blob as non-surface', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(3), new TextEncoder().encode('not-json'))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(3))
  })

  it('rejects a checkpoint whose surfaceOp is append, not replace', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } }, surfaceOp: 'append' })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a summary marker with a negative shadowedSeq', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: -1, end: 5 }, shadowedSeqs: [-1, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must carry a non-negative safe integer shadowedRange',
    )
  })

  it('rejects a summary blob whose seq count differs from the shadowed set', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'summary blob shadowedSeqs must describe the same number of surface events as shadowedIds',
    )
  })

  it('rejects a compaction/end marker recording a failure', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null, error: 'boom' } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_103 records a failed compaction',
    )
  })

  it('rejects a replacement blob with a fractional time', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9.5, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a { type, time, data } event envelope',
    )
  })

  it('rejects compaction markers outside the turn enclosing the shadowed range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 7, data: { turn: 7 } })))
    // The new start marker is turn: null while the shadowed range is inside turn 7.
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction markers must belong to the turn enclosing the shadowed range',
    )
  })

  it('accepts compaction markers in the turn enclosing the shadowed range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 7, data: { turn: 7 } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('tracks nested turns when locating the enclosing turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 8 } })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 6, data: { turn: 8 } })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 7, data: { turn: 7 } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 8 } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 8 } })))
    // The boundary is inside the innermost turn 8 despite the outer turn 7.
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('accepts a turn enclosing the range that carries no id', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: {} })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 7, data: {} })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('rejects a numeric marker turn after an inner turn/end cleared the cursor', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // turn 8 opens and closes before the shadowed range, clearing the replay
    // cursor to null; a marker naming the outer turn 7 would be accepted by a
    // stack model but rejected by validateOwner ('appended outside any open
    // turn'), so the cursor model must reject it here.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 8 } })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 6, data: { turn: 8 } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction markers with a numeric turn must sit inside an open turn',
    )
  })

  it('tracks a turn/end inside the walked range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 1, data: { turn: 7 } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    // The turn closes before the shadowed range, so a null-owner marker is legal.
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('treats a non-record JSON candidate blob as non-turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode('[1,2]'))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('tolerates an unbalanced turn/end before the shadowed range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null } })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.entries.map(entry => entry.eventId)).toContain(eventId(100))
  })

  it('rejects a numeric marker turn outside an open turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 7 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction markers with a numeric turn must sit inside an open turn',
    )
  })

  it('rejects a summary blob with a malformed usage cacheReadTokens', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 'x' } },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.usage must be a token usage record',
    )
  })

  it('round-trips a compacted file through the durable boundary', () => {
    const next = performCompaction(makeFile(), input())
    const loaded = deserializeSessionFile(serializeSessionFile(next))
    expect(loaded.entries.map(entry => entry.eventId)).toEqual(next.entries.map(entry => entry.eventId))
    expect(loaded.compacted).toEqual(next.compacted)
    expect(loaded.references).toEqual(next.references)
  })

  it('rejects a summary blob with a malformed usage cacheWriteTokens', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 'x' } },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.usage must be a token usage record',
    )
  })

  it('rejects a non-numeric nextEventCounter', () => {
    expect(() => performCompaction(makeFile(), { ...input(), nextEventCounter: -1 })).toThrow(
      'compaction input nextEventCounter must exceed the replacement EventIds and the session counter',
    )
  })

  it('rejects a summary blob whose text block has a non-string text', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [{ type: 'text', text: 5 }], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.summary must be a content block array',
    )
  })

  it('rejects a summary blob with a malformed usage reasoningTokens', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 'x' } },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction/summary blob data.usage must be a token usage record',
    )
  })

  it('accepts a non-text content block in the summary', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [{ type: 'reasoning', text: 'x' }], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    const next = performCompaction({ ...file, blobs }, input())
    expect(next.compacted[0]!.summary).toEqual([{ type: 'reasoning', text: 'x' }])
  })

  it('carries the session metadata into the compacted record', () => {
    const file = makeFile()
    const session = { ...file.session, cwd: '/tmp/work', parentSession: 'sess_parent' as SessionId, origin: 'subagent' as const, delegationDepth: 2, agentPreset: 'headless' }
    const next = performCompaction({ ...file, session }, input())
    expect(next.session).toMatchObject({
      cwd: '/tmp/work', parentSession: 'sess_parent', origin: 'subagent', delegationDepth: 2, agentPreset: 'headless',
    })
  })

  it('rejects a nextEventCounter that does not exceed the replacement EventIds', () => {
    expect(() => performCompaction(makeFile(), { ...input(), nextEventCounter: 100 })).toThrow(
      'compaction input nextEventCounter must exceed the replacement EventIds and the session counter',
    )
  })

  it('rejects replacement EventIds below the session counter', () => {
    // The session counter has advanced to 100 but no entry carries evt_10..13;
    // reusing those identities below the high-water mark must be refused.
    const file = { ...makeFile(), session: { ...makeFile().session, nextEventCounter: 100 } }
    expect(() => performCompaction(file, {
      ...input(),
      startEventId: eventId(10),
      summaryEventId: eventId(11),
      checkpointEventId: eventId(12),
      endEventId: eventId(13),
    })).toThrow('compaction input nextEventCounter must exceed the replacement EventIds and the session counter')
  })

  it('accepts a summary marker with a reversed surface-order shadowedRange', () => {
    // shadowedRange is a surface-POSITION span, not a numeric interval: after
    // a prior replace lands a fresh high-seq checkpoint at an older position,
    // start can be greater than end (see dsh-compaction CompactionResult).
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 5, end: 2 }, shadowedSeqs: [5, 2], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).not.toThrow(
      'replacement blob blob_102 must carry a non-negative safe integer shadowedRange',
    )
  })

  it('accepts a summary marker whose shadowedSeqs are not numerically increasing', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 4, end: 2 }, shadowedSeqs: [4, 5, 2], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    // The seq-array check only requires the first and last entries to match the
    // range endpoints; surface order need not be numerically increasing. The
    // count must still describe the three shadowed surface events.
    expect(() => performCompaction({ ...file, blobs }, input())).not.toThrow(
      'replacement blob blob_102 must carry a shadowedSeqs array spanning its shadowedRange',
    )
  })

  it('rejects a checkpoint blob whose data.source is missing', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { checkpoint: true },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a checkpoint blob whose data.source belongs to another compaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { checkpoint: true, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_other' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a checkpoint blob that is not a user/message event', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'assistant/message', time: 9,
      data: { checkpoint: true, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects replacement EventIds without the session prefix or a numeric suffix', () => {
    expect(() => performCompaction(makeFile(), {
      ...input(),
      startEventId: 'evt_other_9' as EventId,
    })).toThrow('replacement EventId evt_other_9 must carry the session prefix and a numeric suffix')
  })

  it('rejects an empty compactionId', () => {
    expect(() => performCompaction(makeFile(), { ...input(), compactionId: '' as CompactionId })).toThrow(
      'compaction input compactionId must be a non-empty string',
    )
  })

  it('rejects a checkpoint whose surfaceOp carries extra keys', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { checkpoint: true, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5, extra: true },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must be a surface event carrying a replace surfaceOp',
    )
  })

  it('rejects a checkpoint whose replace range differs from the summary range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 4 },
      sourceEventSeqs: [2, 4],
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint replace range must match the summary shadowedRange',
    )
  })

  it('rejects a checkpoint whose sourceEventSeqs omit a shadowed surface node', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 4],
    })))
    // The summary cites shadowed surface nodes 2, 4, and 5; the checkpoint
    // omits 5, which foldSurface's assertProvenance would reject at restore.
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must cite every shadowed surface node in sourceEventSeqs',
    )
  })

  it('rejects a summary marker blob that carries surface metadata', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm' },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_102 must not carry surface metadata',
    )
  })

  it('rejects a marker blob that carries surface metadata', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 9,
      data: { compactionId: 'compact_1', turn: null },
      sourceEventSeqs: [2],
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must not carry surface metadata',
    )
  })

  it('rejects a checkpoint whose sourceEventSeqs is empty', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [],
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must cite every shadowed surface node in sourceEventSeqs',
    )
  })

  it('rejects a checkpoint whose sourceEventSeqs contains duplicates', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 2, 4, 5],
    })))
    // Duplicates would make the restored surface provenance ambiguous, so the
    // write side rejects them like the import side does.
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must cite every shadowed surface node in sourceEventSeqs',
    )
  })

  it('rejects a checkpoint whose sourceEventSeqs is not an array', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: 42,
    })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'checkpoint blob must cite every shadowed surface node in sourceEventSeqs',
    )
  })

  it('rejects a replacement blob whose ignorable marker is not true', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null }, ignorable: false,
    })))
    // Session.fromRestore accepts an ignorable marker only as true or absent,
    // so a file carrying this blob could never be restored.
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a { type, time, data } event envelope',
    )
  })

  it('rejects a replacement blob carrying an unknown top-level key', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null }, extra: 1,
    })))
    // Session.fromRestore rejects any envelope key outside its whitelist, so
    // a blob carrying an extra key would be written but could never restore.
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'replacement blob blob_101 must be a { type, time, data } event envelope',
    )
  })

  it('rejects a checkpoint whose sourceCommandId disagrees with the start marker', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(100), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 9,
      data: { id: 'm100', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: 'cmd_a' } },
      surfaceOp: { op: 'replace', start: 2, end: 5 },
      sourceEventSeqs: [2, 4, 5],
    })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_b' } })))
    blobs.set(blobId(102), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 2, end: 5 }, shadowedSeqs: [2, 4, 5], shadowedTokenCount: 0, provider: 'p', model: 'm', sourceCommandId: 'cmd_b' },
    })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_b' } })))
    // The summary marker is aligned too, so the only mismatch is the
    // checkpoint provenance (cmd_a) against the start marker (cmd_b).
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction marker blobs must carry a consistent sourceCommandId',
    )
  })

  it('rejects a numeric marker turn when an orphaned turn/end precedes the range', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // evt_0 is an orphaned turn/end (no matching turn/start); a numeric
    // marker turn has no open turn to belong to.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 0, data: { turn: 1, reason: { kind: 'success' } } })))
    blobs.set(blobId(101), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_1', turn: 5 } })))
    blobs.set(blobId(103), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_1', turn: 5 } })))
    expect(() => performCompaction({ ...file, blobs }, input())).toThrow(
      'compaction markers with a numeric turn must sit inside an open turn',
    )
  })

  it('derives the range endpoints from surface events when a whole bracket is retired', () => {
    // Retiring the whole first-transaction bracket shadows its log-only
    // start/summary/end markers too; the recorded range must still span the
    // surface events, not the markers.
    const once = performCompaction(makeFile(), input())
    const blobs = new Map(once.blobs)
    blobs.set(blobId(200), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 9, data: { id: 'm200', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_2' } }, surfaceOp: { op: 'replace', start: 100, end: 100 }, sourceEventSeqs: [100] })))
    blobs.set(blobId(201), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(202), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 9,
      data: { compactionId: 'compact_2', summary: [], shadowedRange: { start: 100, end: 100 }, shadowedSeqs: [100], shadowedTokenCount: 0, provider: 'deepseek', model: 'deepseek-chat' },
    })))
    blobs.set(blobId(203), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 9, data: { compactionId: 'compact_2', turn: null } })))
    const again = performCompaction({ ...once, blobs }, {
      ...input(),
      shadowedIds: [eventId(101), eventId(102), eventId(100), eventId(103)],
      checkpointEventId: eventId(200),
      checkpointBlobId: blobId(200),
      startEventId: eventId(201),
      summaryEventId: eventId(202),
      endEventId: eventId(203),
      startBlobId: blobId(201),
      summaryBlobId: blobId(202),
      endBlobId: blobId(203),
      compactionId: 'compact_2' as CompactionId,
      nextRevision: 'rev-3' as SessionRevision,
      nextEventCounter: 300,
    })
    // The range endpoints are the retired surface checkpoint (evt_100), not
    // the log-only start/end markers.
    expect(again.compacted[0]!.shadowedRange).toEqual({ startId: eventId(100), endId: eventId(100) })
  })
})

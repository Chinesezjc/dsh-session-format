import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionTree } from '../src/btree.ts'
import {
  deserializeSessionFile,
  exportSessionFile,
  readSessionFile,
  serializeSessionFile,
  treeFromFile,
  writeSessionFile,
  type SessionFile,
} from '../src/file.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  BlobId,
  CommandId,
  CompactionId,
  CompactionSummary,
  EventId,
  PageId,
  ReferenceRecord,
  SessionId,
  SessionRevision,
  StoredSessionRecord,
} from '../src/index.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function sessionId(): SessionId {
  return 'sess_test' as SessionId
}

function eventId(n: number): EventId {
  return `evt_sess_test_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

function makeFile(options: {
  readonly markers?: boolean
  /** When set, the compaction/summary marker blob carries this side table's payload. */
  readonly summaryFrom?: CompactionSummary
} = {}): SessionFile {
  let tree = SessionTree.empty()
  const blobs = new Map<BlobId, Uint8Array>()
  for (let i = 0; i < 5; i++) {
    const id = eventId(i)
    const blob = blobId(i)
    tree = tree.append(id, blob)
    let payload: string
    if (options.markers === true && i === 2) {
      const from = options.summaryFrom
      const range = from?.shadowedSeqRange ?? { start: 20, end: 21 }
      const seqs = from === undefined ? [20, 21] : [...from.shadowedSeqs]
      payload = JSON.stringify({
        type: 'user/message', time: i,
        data: {
          id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }],
          source: {
            kind: 'plugin', plugin: 'compact', compactionId: 'compact_1',
            ...(from?.sourceCommandId === undefined ? {} : { sourceCommandId: from.sourceCommandId }),
          },
        },
        surfaceOp: { op: 'replace', start: range.start, end: range.end },
        sourceEventSeqs: seqs,
      })
    } else if (options.markers === true && i === 0) {
      payload = JSON.stringify({
        type: 'compaction/start', time: i,
        data: {
          compactionId: 'compact_1', turn: null,
          ...(options.summaryFrom?.sourceCommandId === undefined ? {} : { sourceCommandId: options.summaryFrom.sourceCommandId }),
        },
      })
    } else if (options.markers === true && i === 1) {
      const from = options.summaryFrom
      payload = JSON.stringify({
        type: 'compaction/summary', time: i,
        data: {
          compactionId: 'compact_1',
          ...(from === undefined
            ? {
              summary: [],
              shadowedRange: { start: 20, end: 21 },
              shadowedSeqs: [20, 21],
              shadowedTokenCount: 0,
              provider: 'p',
              model: 'm',
            }
            : {
              summary: from.summary,
              shadowedRange: from.shadowedSeqRange,
              shadowedSeqs: [...from.shadowedSeqs],
              shadowedTokenCount: from.shadowedTokenCount,
              provider: from.provider,
              model: from.model,
              ...(from.sourceCommandId === undefined ? {} : { sourceCommandId: from.sourceCommandId }),
              ...(from.maxTokens === undefined ? {} : { maxTokens: from.maxTokens }),
              ...(from.usage === undefined ? {} : { usage: from.usage }),
              ...(from.llmStreamCall === undefined ? {} : { llmStreamCall: from.llmStreamCall }),
              ...(from.rawOutput === undefined ? {} : { rawOutput: from.rawOutput }),
            }),
        },
      })
    } else if (options.markers === true && i === 3) {
      payload = JSON.stringify({
        type: 'compaction/end', time: i,
        data: {
          compactionId: 'compact_1', turn: null,
          ...(options.summaryFrom?.sourceCommandId === undefined ? {} : { sourceCommandId: options.summaryFrom.sourceCommandId }),
        },
      })
    } else {
      payload = `event-${i}`
    }
    blobs.set(blob, new TextEncoder().encode(payload))
  }
  const session: StoredSessionRecord = {
    sessionId: sessionId(),
    formatVersion: 1,
    nextEventCounter: 100,
    rootPage: 'page_root' as PageId,
    revision: 'rev-1' as SessionRevision,
    backups: [],
  }
  const references: ReferenceRecord[] = [
    { fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: [eventId(1)] },
  ]
  return { session, entries: tree.entries(), blobs, references, compacted: [] }
}

function payload(): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(serializeSessionFile(makeFile()))) as Record<string, unknown>
}

function expectInvalid(mutate: (payload: Record<string, unknown>) => void): void {
  const next = payload()
  mutate(next)
  expect(() => deserializeSessionFile(new TextEncoder().encode(JSON.stringify(next)))).toThrow()
}

describe('session file round-trip', () => {
  it('serializes and deserializes a session file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-format-'))
    const path = join(dir, 'session.dsh')
    await writeSessionFile(path, makeFile())
    const loaded = await readSessionFile(path)
    expect(loaded.entries.map(entry => entry.eventId)).toEqual([
      eventId(0),
      eventId(1),
      eventId(2),
      eventId(3),
      eventId(4),
    ])
    expect(Array.from(loaded.blobs.get(blobId(2))!)).toEqual(Array.from(new TextEncoder().encode('event-2')))
    expect(loaded.references).toHaveLength(1)
    expect(loaded.compacted).toEqual([])
    expect(treeFromFile(loaded).size).toBe(5)
  })

  it('round-trips a file that carries a compaction summary', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: {
        startEventId: eventId(0),
        summaryEventId: eventId(1),
        endEventId: eventId(3),
      },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'text', text: 'summarized' }],
      shadowedTokenCount: 42,
      provider: 'deepseek',
      model: 'deepseek-chat',
    }]
    const withSummary = { ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }
    const loaded = deserializeSessionFile(serializeSessionFile(withSummary))
    expect(loaded.compacted).toEqual(compacted)
  })

  it('replaces an existing file atomically', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-format-'))
    const path = join(dir, 'session.dsh')
    await writeSessionFile(path, makeFile())
    const updated = { ...makeFile(), session: { ...makeFile().session, revision: 'rev-2' as SessionRevision } }
    await writeSessionFile(path, updated)
    expect((await readSessionFile(path)).session.revision).toBe('rev-2')
  })

  it('rejects writes when the target directory does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-format-'))
    await expect(writeSessionFile(join(dir, 'missing', 'session.dsh'), makeFile())).rejects.toThrow()
  })


  it('round-trips a blob whose id is a prototype key', () => {
    const file = makeFile()
    const withProtoBlob = {
      ...file,
      blobs: new Map([...file.blobs, ['__proto__' as BlobId, new TextEncoder().encode('proto-blob')] as const]),
    }
    const loaded = deserializeSessionFile(serializeSessionFile(withProtoBlob))
    expect(Array.from(loaded.blobs.get('__proto__' as BlobId)!)).toEqual(Array.from(new TextEncoder().encode('proto-blob')))
  })

  it('rejects non-JSON bytes', () => {
    expect(() => deserializeSessionFile(new TextEncoder().encode('not json'))).toThrow()
  })

  it('rejects an unknown format marker', () => {
    expectInvalid((next) => { next.format = 'other' })
  })

  it('rejects an unknown version', () => {
    expectInvalid((next) => { next.version = 2 })
  })
})

describe('session file validation', () => {
  it('rejects a session that is not an object', () => {
    expectInvalid((next) => { next.session = null })
  })

  it('rejects a session with a non-string sessionId', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), sessionId: 42 } })
  })

  it('rejects a session with a non-number formatVersion', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), formatVersion: '1' } })
  })

  it('rejects a session with an unsupported formatVersion', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), formatVersion: 999 } })
  })

  it('rejects a session with non-array backups', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), backups: 'x' } })
  })

  it('rejects a session with a malformed backup record', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), backups: [{ rootPage: 5 }] } })
  })

  it('rejects a session with a non-string seedBoundaryId', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), seedBoundaryId: 42 } })
  })

  it('rejects entries that are not an array', () => {
    expectInvalid((next) => { next.entries = 'x' })
  })

  it('rejects an entry that is not an object', () => {
    expectInvalid((next) => { next.entries = [5] })
  })

  it('rejects an entry with a non-finite order', () => {
    const entry = (payload().entries as Array<Record<string, unknown>>)[0]
    expectInvalid((next) => { next.entries = [{ ...entry, order: 'a' }] })
    expectInvalid((next) => { next.entries = [{ ...entry, order: Number.NaN }] })
  })

  it('rejects an entry with a non-string eventId', () => {
    const entry = (payload().entries as Array<Record<string, unknown>>)[0]
    expectInvalid((next) => { next.entries = [{ ...entry, eventId: 5 }] })
  })

  it('rejects an entry with a non-string blobId', () => {
    const entry = (payload().entries as Array<Record<string, unknown>>)[0]
    expectInvalid((next) => { next.entries = [{ ...entry, blobId: null }] })
  })

  it('rejects entries that are not strictly increasing in order', () => {
    const entries = payload().entries as Array<Record<string, unknown>>
    const first = entries[0]!
    expectInvalid((next) => { next.entries = [first, { ...first, order: first.order as number }] })
  })

  it('rejects duplicate entry eventIds', () => {
    const entries = payload().entries as Array<Record<string, unknown>>
    const first = entries[0]!
    const second = entries[1]!
    expectInvalid((next) => { next.entries = [first, { ...second, eventId: first.eventId }] })
  })

  it('rejects blobs that are not an object', () => {
    expectInvalid((next) => { next.blobs = 'x' })
  })

  it('rejects a blob that is not an object', () => {
    expectInvalid((next) => { next.blobs = { blob_0: null } })
  })

  it('rejects a blob with a non-string base64 field', () => {
    expectInvalid((next) => { next.blobs = { blob_0: { base64: 42 } } })
  })

  it('rejects a blob whose base64 does not round-trip', () => {
    expectInvalid((next) => { next.blobs = { blob_0: { base64: '!!!' } } })
  })

  it('rejects references that are not an array', () => {
    expectInvalid((next) => { next.references = 'x' })
  })

  it('rejects a reference that is not an object', () => {
    expectInvalid((next) => { next.references = [5] })
  })

  it('rejects a reference with a non-string fromEventId', () => {
    expectInvalid((next) => { next.references = [{ fromEventId: 5 }] })
  })

  it('rejects a reference with a non-string refName', () => {
    expectInvalid((next) => { next.references = [{ fromEventId: 'x', refName: 5 }] })
  })

  it('rejects a reference with non-string-array toEventIds', () => {
    expectInvalid((next) => { next.references = [{ fromEventId: 'x', refName: 'y', toEventIds: 'z' }] })
  })

  it('rejects compacted summaries that are not an array', () => {
    expectInvalid((next) => { next.compacted = 'x' })
  })

  it('rejects a compaction summary that is not an object', () => {
    expectInvalid((next) => { next.compacted = [5] })
  })

  it('rejects a compaction summary with a non-string compactionId', () => {
    expectInvalid((next) => { next.compacted = [{ compactionId: 5 }] })
  })

  it('rejects a compaction summary with a non-string checkpointEventId', () => {
    expectInvalid((next) => { next.compacted = [{ compactionId: 'x', checkpointEventId: 5 }] })
  })

  it('rejects a compaction summary with a malformed shadowedRange', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'x',
        checkpointEventId: 'y',
        markerEventIds: { startEventId: 'a', summaryEventId: 'b', endEventId: 'c' },
        shadowedRange: 'z',
      }]
    })
  })

  it('rejects a compaction summary with non-string-array shadowedIds', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'x',
        checkpointEventId: 'y',
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: 'a', endId: 'b' },
        shadowedIds: 5,
      }]
    })
  })

  it('rejects an entry that references a missing blob', () => {
    expectInvalid((next) => {
      const blobs = next.blobs as Record<string, unknown>
      delete blobs.blob_0
    })
  })

  it('rejects a reference sourced by a missing event', () => {
    expectInvalid((next) => {
      next.references = [{ fromEventId: 'evt_missing', refName: 'sourceEventIds', toEventIds: [eventId(1)] }]
    })
  })

  it('rejects a reference targeting a missing event', () => {
    expectInvalid((next) => {
      next.references = [{ fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: ['evt_missing'] }]
    })
  })

  it('rejects a seedBoundaryId that targets a missing event', () => {
    expectInvalid((next) => {
      next.session = { ...(next.session as object), seedBoundaryId: 'evt_missing' }
    })
  })

  it('rejects a compaction summary whose checkpoint event is missing', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: 'evt_missing',
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: 'a', endId: 'b' },
        shadowedIds: [],
        shadowedSeqRange: { start: 0, end: 1 },
        shadowedSeqs: [],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects bytes that are not valid UTF-8', () => {
    expect(() => deserializeSessionFile(new Uint8Array([0xff, 0xfe, 0x00, 0x31]))).toThrow()
  })

  it('rejects duplicate reference keys', () => {
    expectInvalid((next) => {
      next.references = [
        { fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: [eventId(1)] },
        { fromEventId: eventId(4), refName: 'sourceEventIds', toEventIds: [eventId(2)] },
      ]
    })
  })


  it('rejects an invalid file without replacing the existing one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-format-'))
    const path = join(dir, 'session.dsh')
    await writeSessionFile(path, makeFile())
    const broken = { ...makeFile(), blobs: new Map(makeFile().blobs) }
    broken.blobs.delete(blobId(0))
    await expect(writeSessionFile(path, broken)).rejects.toThrow('references missing blob')
    const loaded = await readSessionFile(path)
    expect(loaded.blobs.has(blobId(0))).toBe(true)
  })


  it('rejects a compaction summary that lists a live event as shadowed', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: {
        startEventId: eventId(0),
        summaryEventId: eventId(1),
        endEventId: eventId(3),
      },
      shadowedRange: { startId: eventId(2), endId: eventId(21) },
      shadowedIds: [eventId(2), eventId(21)],
      shadowedSeqRange: { start: 2, end: 21 },
      shadowedSeqs: [2, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const file = makeFile({ markers: true, summaryFrom: compacted[0]! })
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, compacted }))).toThrow(
      'lists live event evt_sess_test_2 as shadowed',
    )
  })

  it('rejects exporting a file whose cross-references do not hold', () => {
    const broken = { ...makeFile(), blobs: new Map(makeFile().blobs) }
    broken.blobs.delete(blobId(0))
    expect(() => exportSessionFile(broken)).toThrow('references missing blob')
  })


  it('round-trips a session carrying a backup record', () => {
    const file = makeFile()
    const withBackup = {
      ...file,
      session: { ...file.session, backups: [{ rootPage: 'page_b1' as PageId }] },
    }
    const loaded = deserializeSessionFile(serializeSessionFile(withBackup))
    expect(loaded.session.backups).toEqual([{ rootPage: 'page_b1' }])
  })

  it('round-trips a session carrying a usedEventBindings table', () => {
    const file = makeFile()
    const withBindings = {
      ...file,
      session: {
        ...file.session,
        usedEventBindings: new Map([[eventId(0), blobId(0)], [eventId(1), blobId(1)]]),
      },
    }
    const loaded = deserializeSessionFile(serializeSessionFile(withBindings))
    expect(loaded.session.usedEventBindings).toEqual(new Map([[eventId(0), blobId(0)], [eventId(1), blobId(1)]]))
  })

  it('rejects a session with a malformed usedEventBindings table', () => {
    expectInvalid((next) => {
      next.session = { ...(next.session as object), usedEventBindings: { evt_1: 42 } }
    })
    expectInvalid((next) => {
      next.session = { ...(next.session as object), usedEventBindings: 42 }
    })
  })

  it('rejects a backup record with a non-string page pointer', () => {
    expectInvalid((next) => {
      next.session = { ...(next.session as object), backups: [{ rootPage: 'p', referencesPage: 5 }] }
    })
  })


  it('rejects a compaction summary whose summary is not a block array', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: 'x',
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose token count is not a number', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 'x',
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose provider or model is not a string', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 5,
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose rawOutput is not a block array', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        rawOutput: 'x',
      }]
    })
  })


  it('rejects a compaction summary whose rawOutput has a non-record entry', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: {
          startEventId: eventId(0),
          summaryEventId: eventId(1),
          endEventId: eventId(4),
        },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        rawOutput: [5],
      }]
    })
  })

  it('round-trips a compaction summary carrying rawOutput', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: {
        startEventId: eventId(0),
        summaryEventId: eventId(1),
        endEventId: eventId(3),
      },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      rawOutput: [{ type: 'text', text: 'raw' }],
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }))
    expect(loaded.compacted[0]!.rawOutput).toEqual([{ type: 'text', text: 'raw' }])
  })


  it('rejects a compaction summary whose markerEventIds is not an object', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: 'x',
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary with malformed markerEventIds', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: 5, summaryEventId: 'evt_m', endEventId: 'evt_o' },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose shadowed range lists a live event', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(2), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a compaction summary with a non-string sourceCommandId', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        sourceCommandId: 5,
      }]
    })
  })

  it('rejects a compaction summary with a non-number maxTokens', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        maxTokens: 'x',
      }]
    })
  })

  it('rejects a compaction summary with a non-object usage', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        usage: 5,
      }]
    })
  })

  it('round-trips a compaction summary carrying every optional field', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      sourceCommandId: 'cmd_1' as CommandId,
      maxTokens: 100,
      usage: { inputTokens: 5, outputTokens: 5 },
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'raw' }],
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }))
    expect(loaded.compacted[0]).toMatchObject({
      sourceCommandId: 'cmd_1' as CommandId,
      maxTokens: 100,
      usage: { inputTokens: 5, outputTokens: 5 },
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'raw' }],
    })
  })


  it('rejects a compaction summary with a non-boolean llmStreamCall', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        llmStreamCall: 'yes',
      }]
    })
  })


  it('rejects a session with a non-number createdAt', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), createdAt: 'x' } })
  })

  it('rejects a session with a negative createdAt', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), createdAt: -1 } })
  })

  it('rejects a session with a fractional createdAt', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), createdAt: 1.5 } })
  })

  it('rejects a compaction summary with llmStreamCall true and no rawOutput', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        llmStreamCall: true,
      }]
    })
  })


  it('rejects a compaction summary whose marker event is missing', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: 'evt_missing' as EventId, summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a compaction summary with a non-numeric shadowedSeqRange', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: 'x',
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a compaction summary with non-numeric shadowedSeqs', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 0, end: 1 },
        shadowedSeqs: 'x',
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('accepts a compaction summary with a reversed shadowedSeqRange', () => {
    // shadowedSeqRange is a surface-POSITION span: after a prior replace the
    // seq endpoints can be numerically reversed (see dsh-compaction
    // CompactionResult), so the deserializer must not require start <= end.
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 21, end: 20 },
      shadowedSeqs: [21, 20],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }))
    expect(loaded.compacted[0]!.shadowedSeqRange).toEqual({ start: 21, end: 20 })
  })

  it('rejects a compaction summary whose shadowedRange endpoint is not in shadowedIds', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(99) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose marker blob is not a JSON envelope', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode('not-json'))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_1 is not a JSON envelope',
    )
  })

  it('rejects a compaction summary whose marker event has the wrong type', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // evt_3 is the end marker but holds a start-typed event.
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_3 must be a compaction/end event of the same compaction',
    )
  })

  it('rejects a compaction summary whose marker event belongs to another compaction', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_other', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_3 must be a compaction/end event of the same compaction',
    )
  })

  it('rejects a compaction summary whose checkpoint marker has an invalid envelope', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 2, data: { id: 'm2', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: { op: 'replace', start: 0, end: 3 } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'checkpoint marker event evt_sess_test_2 has an invalid envelope',
    )
  })

  it('imports a summary whose content-block keys are reordered', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // An external writer may serialize the block with its keys in a different
    // order; structural equality must accept the semantically identical blob.
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: {
        compactionId: 'compact_1',
        summary: [{ text: 'checkpoint', type: 'text' }],
        shadowedRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))
    expect(loaded.compacted[0]?.summary).toEqual([{ type: 'text', text: 'checkpoint' }])
  })

  it('rejects a compaction summary whose marker carries a non-safe-integer time', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1.5,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_1 has an invalid envelope',
    )
  })

  it('rejects a compaction summary whose marker carries a non-true ignorable marker', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // Session.fromRestore accepts an ignorable marker only as true or absent,
    // so a file carrying this blob could never be restored.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null }, ignorable: false,
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_0 has an invalid envelope',
    )
  })

  it('rejects a compaction summary whose bracket crosses a session/end-seed', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // Replay's invariant clears the compaction trace at an end-seed, so a
    // claimed bracket crossing one would leave the summary without its start.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'session/end-seed', time: 1, data: { reason: 'restore' } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 5, data: { compactionId: 'compact_1', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(2), endEventId: eventId(5) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))).toThrow('bracket crosses end-seed event evt_sess_test_1')
  })

  it('rejects a compaction summary whose marker carries an unknown top-level key', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // Session.fromRestore rejects any envelope key outside its whitelist, so
    // a marker carrying an extra key could be written and imported but never
    // restored.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null }, extra: 1,
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_0 has an invalid envelope',
    )
  })

  it('rejects a compaction summary whose marker event is not a record envelope', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // A non-record JSON value fails the envelope shape check (including the
    // required non-negative safe-integer time) at import.
    blobs.set(blobId(1), new TextEncoder().encode('[1, 2]'))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_1 has an invalid envelope',
    )
  })

  it('rejects a compaction summary whose marker payload does not match the side table', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // The summary marker event and the compacted side table must mirror each
    // other; a drifted archive would import and replay two different facts.
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: {
        compactionId: 'compact_1',
        summary: [{ type: 'text', text: 'other' }],
        shadowedRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'payload does not match the summary marker event',
    )
  })

  it('rejects a compaction summary whose summary differs structurally from the marker payload', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // Same key count and value type, but a different primitive and a missing
    // key respectively; the structural comparison must reject both even
    // though JSON.stringify of the side table would be order-stable here.
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: {
        compactionId: 'compact_1',
        summary: [{ type: 'text', text: 'a', extra: ['x'] }],
        shadowedRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'text', text: 'a', extra: 'x' }] as unknown as ContentBlock[],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'payload does not match the summary marker event',
    )
  })

  it('rejects a compaction summary whose summary blocks have different key counts', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: {
        compactionId: 'compact_1',
        summary: [{ type: 'text', text: 'a', note: 'x' }],
        shadowedRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'text', text: 'a' }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'payload does not match the summary marker event',
    )
  })

  it('rejects a compaction summary whose marker carries surface metadata', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 0,
      data: { compactionId: 'compact_1', turn: null },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_0 must not carry surface metadata',
    )
  })

  it('rejects a compaction summary whose marker blob has invalid UTF-8', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/summary', time: 1, data: { compactionId: 'compact_1' } })).slice(0, 4))
    // 0xff is not valid UTF-8; the fatal decoder must reject the marker blob.
    blobs.set(blobId(1), new Uint8Array([0xff, 0xfe, 0xfd]))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_1 is not a JSON envelope',
    )
  })

  it('rejects a compaction summary whose marker event id is not in entries', () => {
    const file = makeFile({ markers: true })
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(99), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, compacted }))).toThrow(
      'targets missing marker event evt_sess_test_99',
    )
  })

  it('rejects a compaction summary whose checkpoint marker data is not a record', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: 2, data: [1, 2], surfaceOp: { op: 'replace', start: 0, end: 3 } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'checkpoint marker event evt_sess_test_2 has an invalid envelope',
    )
  })

  it('rejects a checkpoint whose sourceEventSeqs contains duplicates', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // foldSurface's assertProvenance rejects duplicate source seqs, so the
    // import boundary must too.
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 20, 21],
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'checkpoint marker event evt_sess_test_2 has an invalid envelope',
    )
  })

  it('rejects a compaction summary whose end marker records a failure', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // The side table records the transaction as committed and its events
    // physically removed; a failed end marker contradicts that.
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null, error: 'cancelled' } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'end marker must not record a failed compaction',
    )
  })

  it('rejects a compaction summary whose optional metadata disagrees with the marker', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: {
        compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21],
        shadowedTokenCount: 0, provider: 'p', model: 'm', maxTokens: 200,
      },
    })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      maxTokens: 100,
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'payload does not match the summary marker event',
    )
  })

  it('rejects nested compaction transactions in the entry sequence', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // compact_1 opens at evt_0; compact_2 opens at evt_1 and closes at
    // evt_4 while compact_1 is still open, which replay's compaction
    // invariant rejects. Both brackets are complete in their own markers.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_2', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_2' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 5,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 22, end: 23 }, shadowedSeqs: [22, 23], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 6,
      data: { id: 'm6', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 22, end: 23 },
      sourceEventSeqs: [22, 23],
    })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 7, data: { compactionId: 'compact_1', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
      { order: 6, eventId: eventId(6), blobId: blobId(6) },
      { order: 7, eventId: eventId(7), blobId: blobId(7) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(6),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(5), endEventId: eventId(7) },
      shadowedRange: { startId: eventId(22), endId: eventId(23) },
      shadowedIds: [eventId(22), eventId(23)],
      shadowedSeqRange: { start: 22, end: 23 },
      shadowedSeqs: [22, 23],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }, {
      compactionId: 'compact_2' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(1), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))).toThrow('compaction summaries must not nest or interleave')
  })

  it('rejects a compaction transaction that nests inside an unclaimed one', () => {
    // An orphaned transaction (compaction/start and end only) precedes a
    // complete claimed transaction. The side table does not list the orphan,
    // so the per-summary checks cannot see it; the entry-stream transaction
    // state machine rejects the claimed start while the orphan is still open,
    // which is exactly what replay's invariant does.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_orphan', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 5, data: { compactionId: 'compact_orphan', turn: null, error: { kind: 'failed' } } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(1), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))).toThrow('compaction summaries must not nest or interleave')
  })

  it('accepts a failed compaction transaction with no side-table summary', () => {
    // A migrated legacy log can carry a failed transaction (compaction/start
    // then compaction/end with error) that has no summary by design; the
    // entry-stream state machine must accept it like replay does.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_failed', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, data: { compactionId: 'compact_failed', turn: null, error: { kind: 'failed' } } })))
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, blobs }))
    expect(loaded.compacted).toEqual([])
  })

  it('accepts a migrated successful compaction transaction without a side-table summary', () => {
    // migrateLegacySession carries legacy compaction events through as entries
    // with an empty side table; a successful transaction's markers are all
    // unclaimed but must import, since replay validates the stream itself.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, blobs }))
    expect(loaded.compacted).toEqual([])
  })

  it('rejects an unclaimed compaction/end without a summary or error', () => {
    // Replay's invariant requires a successful end to name a summary; a
    // successful transaction whose markers are unclaimed is missing that
    // record, so the file cannot be restorable.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'ends a transaction without a summary',
    )
  })

  it('rejects an unclaimed checkpoint with no open compaction transaction', () => {
    // A user/message carrying checkpoint provenance and a replace surfaceOp
    // but no preceding compaction/start fails replay's validateCheckpoint.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 0,
      data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('rejects an unclaimed checkpoint naming a different open transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 1,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_other' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('rejects a second unclaimed compaction/start while one is open', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_2', turn: null } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'compaction summaries must not nest or interleave',
    )
  })

  it('rejects an unclaimed compaction/start with no compactionId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { turn: null } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('rejects an unclaimed compaction/summary with no open transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 0,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('rejects an unclaimed compaction/end with no open transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 0, data: { compactionId: 'compact_1', turn: null, error: { kind: 'failed' } } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('accepts an end-seed that makes an unclaimed open transaction stale', () => {
    // Replay's invariant clears the compaction trace at an end-seed, so an
    // inherited orphan start followed by an end-seed is a legal stale
    // transaction, and a later claimed transaction still imports.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_orphan', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'session/end-seed', time: 1, data: { reason: 'restore' } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 2, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 3,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 4,
      data: { id: 'm4', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 5, data: { compactionId: 'compact_1', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(4),
      markerEventIds: { startEventId: eventId(2), summaryEventId: eventId(3), endEventId: eventId(5) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))
    expect(loaded.compacted[0]?.compactionId).toBe('compact_1')
  })

  it('rejects an unclaimed transaction with a repeated summary', () => {
    // Replay's invariant rejects a second compaction/summary within one
    // transaction; an unclaimed transaction must too.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'repeats a summary within one transaction',
    )
  })

  it('rejects a claimed summary repeated by an unclaimed summary of the same transaction', () => {
    // An unclaimed summary carrying the claimed transaction's compactionId
    // marks it summarized; the claimed summary that follows must not repeat.
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'repeats a summary within one transaction',
    )
  })

  it('rejects an unclaimed compaction/summary with an invalid payload', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has an invalid summary payload',
    )
  })

  it('rejects an unclaimed checkpoint with an inconsistent sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_a' } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 1,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: 'cmd_b' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must carry a consistent sourceCommandId',
    )
  })

  it('rejects an unclaimed checkpoint in a claimed transaction with a sourceCommandId mismatch', () => {
    // A claimed start names a command; an injected unclaimed checkpoint that
    // omits it must not compare undefined against undefined. The claimed
    // marker group and the side table carry no command id, so the only
    // mismatch is the injected checkpoint's.
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 1,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: 'cmd_b' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'must carry a consistent sourceCommandId',
    )
  })

  it('rejects an unclaimed compaction/start naming a turn that is not open', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: 5 } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'names a turn that is not open',
    )
  })

  it('rejects a standalone unclaimed compaction/start inside an open turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 1 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_1', turn: null } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'names a turn that is not open',
    )
  })

  it('rejects an unclaimed compaction/end whose turn differs from its start', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, data: { compactionId: 'compact_1', turn: 5, error: { kind: 'failed' } } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      "must carry the transaction's turn",
    )
  })

  it('rejects an unclaimed compaction marker carrying surface metadata', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null }, surfaceOp: { op: 'replace', start: 20, end: 21 },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must not carry surface metadata',
    )
  })

  it('rejects an unclaimed compaction marker with an unknown envelope key', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null }, extra: 1,
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has an invalid envelope',
    )
  })

  it('rejects an unclaimed transaction with an inconsistent sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_a' } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_b', error: { kind: 'failed' } } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must carry a consistent sourceCommandId',
    )
  })

  it('rejects an unclaimed compaction/start with a non-numeric turn', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1' } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has no open compaction transaction',
    )
  })

  it('rejects an unclaimed compaction/summary carrying surface metadata', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must not carry surface metadata',
    )
  })

  it('rejects an unclaimed compaction/summary with an inconsistent sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_a' } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm', sourceCommandId: 'cmd_b' },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must carry a consistent sourceCommandId',
    )
  })

  it('rejects an unclaimed compaction/end carrying surface metadata', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/end', time: 1, data: { compactionId: 'compact_1', turn: null, error: { kind: 'failed' } }, sourceEventSeqs: [20],
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must not carry surface metadata',
    )
  })

  it('rejects a turn boundary crossing an open unclaimed compaction transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 1, data: { turn: 1 } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'crosses an open compaction transaction',
    )
  })

  it('rejects a turn/end crossing an open unclaimed compaction transaction', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 1 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_1', turn: 1 } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'success' } } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'crosses an open compaction transaction',
    )
  })

  it('rejects an unclaimed compaction/summary with an unknown envelope key', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1, extra: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has an invalid envelope',
    )
  })

  it('rejects an unclaimed compaction/end with an unknown envelope key', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 1, extra: 1, data: { compactionId: 'compact_1', turn: null, error: { kind: 'failed' } } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'has an invalid envelope',
    )
  })

  it('ignores foreign-prefix EventIds when computing the session counter high-water', () => {
    // The counter is per-session: a forked child inherits parent-prefixed
    // events and must not count their numbers against its own counter.
    const foreign = SessionTree.empty()
      .append(eventId(0), blobId(0))
      .append('evt_sess_other_999' as EventId, blobId(1))
    const session: StoredSessionRecord = {
      sessionId: 'sess_child' as SessionId,
      formatVersion: 1,
      nextEventCounter: 2,
      rootPage: 'page_root' as PageId,
      revision: 'rev-1' as SessionRevision,
      backups: [],
    }
    const loaded = deserializeSessionFile(serializeSessionFile({
      ...makeFile(),
      session,
      entries: foreign.entries(),
      references: [],
    }))
    expect(loaded.session.nextEventCounter).toBe(2)
  })

  it('rejects an unclaimed compaction/start with a non-string sourceCommandId', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 5 } })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs }))).toThrow(
      'must carry a non-empty string sourceCommandId',
    )
  })

  it('accepts a user/message with an append surfaceOp and checkpoint-like source', () => {
    // The invariant treats a message as a checkpoint only when the surfaceOp
    // is a replace op and the source is the compact checkpoint marker; an
    // append message whose extensible source happens to carry a compactionId
    // is a normal message and must not be rejected.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 0,
      data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: 'append',
    })))
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, blobs }))
    expect(loaded.entries).toHaveLength(5)
  })

  it('rejects two compaction summaries sharing a marker event', () => {
    // Both summaries claim evt_0 as their start marker, so replay would see
    // one bracket open while the second summary describes another. Each
    // summary passes its per-summary checks in isolation; the side-table map
    // must reject the shared marker.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 4,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 22, end: 23 }, shadowedSeqs: [22, 23], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 5,
      data: { id: 'm5', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 22, end: 23 },
      sourceEventSeqs: [22, 23],
    })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 6, data: { compactionId: 'compact_1', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
      { order: 6, eventId: eventId(6), blobId: blobId(6) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }, {
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(5),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(4), endEventId: eventId(6) },
      shadowedRange: { startId: eventId(22), endId: eventId(23) },
      shadowedIds: [eventId(22), eventId(23)],
      shadowedSeqRange: { start: 22, end: 23 },
      shadowedSeqs: [22, 23],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))).toThrow('compaction marker evt_sess_test_0 is shared by two summaries')
  })

  it('rejects a compaction summary whose start marker lacks a turn', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1' } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_0 must carry a numeric or null turn',
    )
  })

  it('rejects a compaction summary whose start and end markers name different turns', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: 7 } })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: 8 } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'start and end markers must carry the same turn',
    )
  })

  it('tolerates a non-JSON entry between the bracket markers', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // evt_0 opens the bracket, evt_2 is the summary, evt_3 the checkpoint,
    // and evt_4 closes it; evt_1 between start and summary is not JSON, so
    // the turn-boundary scan skips it instead of misreading it.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))
    expect(loaded.compacted[0]?.compactionId).toBe('compact_1')
  })

  it('skips non-JSON and non-turn entries when scanning the open-turn cursor', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // evt_0 is not JSON, evt_1 is a JSON array (not a record), evt_2 is a
    // turn/start without a turn id (anonymous), and evt_3 is a record whose
    // data is not a record; the scan must skip all of them. evt_4 is a
    // turn/end which closes the cursor. The start marker at evt_5 sits after
    // a cleared cursor with turn null, a legal standalone bracket.
    blobs.set(blobId(0), new TextEncoder().encode('not-json'))
    blobs.set(blobId(1), new TextEncoder().encode('[1, 2]'))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 2, data: {} })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'turn/other', time: 3, data: 5 })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'turn/end', time: 4, data: { turn: 7 } })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 5, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 6,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 7,
      data: { id: 'm7', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(8), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 8, data: { compactionId: 'compact_1', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
      { order: 6, eventId: eventId(6), blobId: blobId(6) },
      { order: 7, eventId: eventId(7), blobId: blobId(7) },
      { order: 8, eventId: eventId(8), blobId: blobId(8) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(7),
      markerEventIds: { startEventId: eventId(5), summaryEventId: eventId(6), endEventId: eventId(8) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, entries: extended.entries(), blobs, compacted }))
    expect(loaded.compacted[0]?.compactionId).toBe('compact_1')
  })

  it('rejects a numeric start marker turn with no open turn at its position', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // The start marker names turn 5 but no turn is open at its position; the
    // replay cursor is null, which validateOwner would reject.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: 5 } })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: 5 } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'start marker must sit inside an open turn',
    )
  })

  it('rejects a null start marker turn while a turn is open at its position', () => {
    const file = makeFile()
    const blobs = new Map(file.blobs)
    // turn 7 is open at the start-marker position (evt_0), so a null owner
    // would be rejected by validateOwner as a standalone bracket inside an
    // open turn. The markers sit at evt_1..evt_4 with the summary at evt_2
    // and the checkpoint immediately after it.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 0, data: { turn: 7 } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 1, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 2,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 3,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(3),
      markerEventIds: { startEventId: eventId(1), summaryEventId: eventId(2), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'start marker must belong to the turn enclosing the range',
    )
  })

  it('rejects a compaction summary whose bracket encloses a turn boundary', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // A turn/start between the checkpoint and end markers would cross the
    // open compaction at replay, which validateTurnBoundary forbids.
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'turn/start', time: 3, data: { turn: 7 } })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 4, data: { compactionId: 'compact_1', turn: null } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(4) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'bracket crosses turn boundary event evt_sess_test_3',
    )
  })

  it('rejects a compaction summary whose markers carry an empty sourceCommandId', () => {
    const file = makeFile({ markers: true })
    const blobs = new Map(file.blobs)
    // The side table carries no sourceCommandId; the empty marker value
    // disagrees with it, which the cross-marker consistency check rejects.
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: '' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: '' } })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null, sourceCommandId: '' } })))
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker events must carry a consistent sourceCommandId',
    )
  })

  it('rejects a compaction summary whose markers disagree on sourceCommandId', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      sourceCommandId: 'cmd_a' as CommandId,
    }]
    const file = makeFile({ markers: true, summaryFrom: compacted[0]! })
    const blobs = new Map(file.blobs)
    // The start marker and the side table agree on 'cmd_a', but the
    // checkpoint source carries 'cmd_b'; the group must share one command id.
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null, sourceCommandId: 'cmd_a' } })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1', sourceCommandId: 'cmd_b' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, blobs, compacted }))).toThrow(
      'marker event evt_sess_test_2 must carry a consistent sourceCommandId',
    )
  })

  it('rejects a compaction summary whose markers are out of order', () => {
    const file = makeFile({ markers: true })
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      // checkpoint (evt_4) lands after end (evt_3): end closes the
      // transaction before the checkpoint opens it.
      checkpointEventId: eventId(4),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    expect(() => deserializeSessionFile(serializeSessionFile({ ...file, compacted }))).toThrow(
      'markers must appear in start, summary, checkpoint, end order',
    )
  })

  it('rejects a compaction summary with llmStreamCall false', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        llmStreamCall: false,
      }]
    })
  })

  it('rejects a compaction summary whose shadowedSeqs do not span the range', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [5],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary with a negative shadowedSeq', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: -1, end: 21 },
        shadowedSeqs: [-1, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary whose checkpoint event is absent from the entries', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: 'evt_ghost' as EventId,
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a reference with duplicate targets', () => {
    expectInvalid((next) => {
      next.references = [{ fromEventId: eventId(0), refName: 'sourceEventIds', toEventIds: [eventId(1), eventId(1)] }]
    })
  })


  it('rejects a compaction summary with empty shadowedIds', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('accepts two sequential claimed compaction transactions', () => {
    // Two complete brackets with disjoint spans import; the rank-only
    // nesting pre-check must not reject sequential transactions.
    const file = makeFile()
    const blobs = new Map(file.blobs)
    blobs.set(blobId(0), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 0, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(1), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 1,
      data: { compactionId: 'compact_1', summary: [], shadowedRange: { start: 20, end: 21 }, shadowedSeqs: [20, 21], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(2), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 2,
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_1' } },
      surfaceOp: { op: 'replace', start: 20, end: 21 },
      sourceEventSeqs: [20, 21],
    })))
    blobs.set(blobId(3), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 3, data: { compactionId: 'compact_1', turn: null } })))
    blobs.set(blobId(4), new TextEncoder().encode(JSON.stringify({ type: 'compaction/start', time: 4, data: { compactionId: 'compact_2', turn: null } })))
    blobs.set(blobId(5), new TextEncoder().encode(JSON.stringify({
      type: 'compaction/summary', time: 5,
      data: { compactionId: 'compact_2', summary: [], shadowedRange: { start: 22, end: 23 }, shadowedSeqs: [22, 23], shadowedTokenCount: 0, provider: 'p', model: 'm' },
    })))
    blobs.set(blobId(6), new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 6,
      data: { id: 'm6', role: 'user', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact_2' } },
      surfaceOp: { op: 'replace', start: 22, end: 23 },
      sourceEventSeqs: [22, 23],
    })))
    blobs.set(blobId(7), new TextEncoder().encode(JSON.stringify({ type: 'compaction/end', time: 7, data: { compactionId: 'compact_2', turn: null } })))
    const extended = SessionTree.fromEntries([
      ...file.entries,
      { order: 5, eventId: eventId(5), blobId: blobId(5) },
      { order: 6, eventId: eventId(6), blobId: blobId(6) },
      { order: 7, eventId: eventId(7), blobId: blobId(7) },
    ])
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }, {
      compactionId: 'compact_2' as CompactionId,
      checkpointEventId: eventId(6),
      markerEventIds: { startEventId: eventId(4), summaryEventId: eventId(5), endEventId: eventId(7) },
      shadowedRange: { startId: eventId(22), endId: eventId(23) },
      shadowedIds: [eventId(22), eventId(23)],
      shadowedSeqRange: { start: 22, end: 23 },
      shadowedSeqs: [22, 23],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({
      ...file,
      entries: extended.entries(),
      blobs,
      compacted,
    }))
    expect(loaded.compacted).toHaveLength(2)
  })

  it('rejects a compaction summary whose usage overflows to Infinity', () => {
    // A JSON literal 1e400 parses to Infinity, which JSON.stringify would
    // rewrite to null and break the round-trip; the import boundary rejects it.
    const payload = JSON.parse(new TextDecoder().decode(serializeSessionFile(makeFile()))) as Record<string, unknown>
    payload.compacted = [{
      compactionId: 'compact_1',
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
      usage: { inputTokens: 1e400, outputTokens: 1 },
    }]
    const text = JSON.stringify(payload).replace('"inputTokens":null', '"inputTokens":1e400')
    expect(() => deserializeSessionFile(new TextEncoder().encode(text))).toThrow(
      'usage must be a token usage record',
    )
  })

  it('rejects a compaction summary whose summary content overflows to Infinity', () => {
    // A JSON literal 1e400 in a content block parses to Infinity, which
    // JSON.stringify would rewrite to null and break the round-trip.
    const payload = JSON.parse(new TextDecoder().decode(serializeSessionFile(makeFile()))) as Record<string, unknown>
    payload.compacted = [{
      compactionId: 'compact_1',
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'image', attachment: { width: 1e400 } }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const text = JSON.stringify(payload).replace('"width":null', '"width":1e400')
    expect(() => deserializeSessionFile(new TextEncoder().encode(text))).toThrow(
      'summary must be a content block array',
    )
  })

  it('rejects a compaction summary whose summary content carries negative zero', () => {
    const payload = JSON.parse(new TextDecoder().decode(serializeSessionFile(makeFile()))) as Record<string, unknown>
    payload.compacted = [{
      compactionId: 'compact_1',
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'image', attachment: { width: -0 } }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const text = JSON.stringify(payload).replace('"width":0', '"width":-0')
    expect(() => deserializeSessionFile(new TextEncoder().encode(text))).toThrow(
      'summary must be a content block array',
    )
  })

  it('rejects a compaction summary with a malformed usage totalTokens', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 'x' },
      }]
    })
  })


  it('rejects a compaction summary with a malformed usage cacheReadTokens', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 'x' },
      }]
    })
  })

  it('rejects a compaction summary with a malformed usage cacheWriteTokens', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 'x' },
      }]
    })
  })


  it('rejects a session with a non-numeric nextEventCounter', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), nextEventCounter: 'x' } })
  })
  it('rejects a session with a malformed blobIdWatermark', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), blobIdWatermark: -1 } })
    expectInvalid((next) => { next.session = { ...(next.session as object), blobIdWatermark: 0.5 } })
  })



  it('rejects a session with a non-string cwd', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), cwd: 5 } })
  })

  it('rejects a session with a negative delegationDepth', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), delegationDepth: -1 } })
  })

  it('rejects a compaction summary with non-distinct markers', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(0), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a summary block of type text without a string text', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [{ type: 'text', text: 5 }],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a compaction summary with a malformed usage reasoningTokens', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 'x' },
      }]
    })
  })


  it('round-trips a compaction summary with a non-text content block', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'reasoning', text: 'x' }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }))
    expect(loaded.compacted[0]!.summary).toEqual([{ type: 'reasoning', text: 'x' }])
  })


  it('rejects a tool-call block with a non-string id', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [{ type: 'tool-call', id: 5, name: 'x', arguments: '{}' }],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a reasoning block with a non-string text', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [{ type: 'reasoning', text: 5 }],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })


  it('rejects a tool-call block with a non-string name', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [{ type: 'tool-call', id: 'a', name: 5, arguments: '{}' }],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a tool-call block with a non-string arguments', () => {
    expectInvalid((next) => {
      next.compacted = [{
        compactionId: 'compact_1',
        checkpointEventId: eventId(2),
        markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
        shadowedRange: { startId: eventId(20), endId: eventId(21) },
        shadowedIds: [eventId(20), eventId(21)],
        shadowedSeqRange: { start: 20, end: 21 },
        shadowedSeqs: [20, 21],
        summary: [{ type: 'tool-call', id: 'a', name: 'x', arguments: 5 }],
        shadowedTokenCount: 0,
        provider: 'p',
        model: 'm',
      }]
    })
  })

  it('rejects a nextEventCounter not exceeding the highest used EventId number', () => {
    expectInvalid((next) => {
      next.session = { ...(next.session as object), nextEventCounter: 1 }
    })
  })


  it('treats an entry EventId without a numeric suffix as zero for the counter', () => {
    const file = makeFile()
    const entries = [...file.entries]
    entries[0] = { ...entries[0], eventId: 'evt_x' as EventId, order: entries[0]!.order, blobId: entries[0]!.blobId }
    const loaded = deserializeSessionFile(serializeSessionFile({ ...file, entries }))
    expect(loaded.entries[0]!.eventId).toBe('evt_x')
  })


  it('round-trips a compaction summary with an image content block', () => {
    const compacted: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: eventId(2),
      markerEventIds: { startEventId: eventId(0), summaryEventId: eventId(1), endEventId: eventId(3) },
      shadowedRange: { startId: eventId(20), endId: eventId(21) },
      shadowedIds: [eventId(20), eventId(21)],
      shadowedSeqRange: { start: 20, end: 21 },
      shadowedSeqs: [20, 21],
      summary: [{ type: 'image', attachment: { attachmentId: AttachmentId('att_1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    }]
    const loaded = deserializeSessionFile(serializeSessionFile({ ...makeFile({ markers: true, summaryFrom: compacted[0]! }), compacted }))
    expect(loaded.compacted[0]!.summary).toEqual([{ type: 'image', attachment: { attachmentId: AttachmentId('att_1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }])
  })


  it('rejects a session with a non-subagent origin', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), origin: 'test' } })
  })

  it('rejects a session with a relative cwd', () => {
    expectInvalid((next) => { next.session = { ...(next.session as object), cwd: 'relative/path' } })
  })

})

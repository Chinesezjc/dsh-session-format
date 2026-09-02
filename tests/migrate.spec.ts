import { describe, expect, it } from 'vitest'
import { SessionFormatEngine } from '../src/engine.ts'
import { migrateLegacySession, type LegacyEvent, type LegacySession } from '../src/migrate.ts'
import { deserializeSessionFile, serializeSessionFile } from '../src/file.ts'
import { PageStore } from '../src/page-store.ts'
import { SessionRepository } from '../src/repository.ts'
import { SessionStore } from '../src/store.ts'
import type { BlobId, PageId, SessionId, SessionRevision } from '../src/index.ts'

function record(): { rootPage: PageId; revision: SessionRevision; nextEventCounter: number } {
  return { rootPage: 'page_sess_legacy' as PageId, revision: 'rev-0' as SessionRevision, nextEventCounter: 10 }
}

function legacySession(): LegacySession {
  return {
    id: 'sess_legacy',
    version: 0,
    createdAt: 1,
    events: [
      {
        seq: 0,
        type: 'user/message',
        time: 1,
        data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
        surfaceOp: 'append',
      },
      {
        seq: 1,
        type: 'assistant/message',
        time: 2,
        data: {
          message: {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
        surfaceOp: 'append',
      },
      {
        seq: 2,
        type: 'tool/result',
        time: 3,
        data: {
          message: {
            id: 'm2',
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }],
            source: { kind: 'tool', callId: 'call-1' },
          },
        },
        surfaceOp: 'append',
        sourceEventSeqs: [0],
      },
    ],
  }
}

describe('migrateLegacySession', () => {
  it('assigns EventIds and migrates references', () => {
    const { file, seqToEventId } = migrateLegacySession(legacySession(), record())
    expect(file.entries).toHaveLength(3)
    expect(seqToEventId.get(0)).toBe('evt_sess_legacy_0')
    expect(file.session.seedBoundaryId).toBeUndefined()
    expect(file.references).toEqual([
      {
        fromEventId: 'evt_sess_legacy_2',
        refName: 'sourceEventIds',
        toEventIds: ['evt_sess_legacy_0'],
      },
    ])
    expect(file.blobs.size).toBe(3)
  })

  it('uses the caller-supplied root page and revision', () => {
    const { file } = migrateLegacySession(legacySession(), { rootPage: 'page_custom' as PageId, revision: 'rev-7' as SessionRevision, nextEventCounter: 10 })
    expect(file.session.rootPage).toBe('page_custom')
    expect(file.session.revision).toBe('rev-7')
  })

  it('rejects an unsupported legacy version', () => {
    expect(() => migrateLegacySession({ ...legacySession(), version: 2 }, record())).toThrow(
      'unsupported legacy session version 2',
    )
  })

  it('rejects a fork-child legacy session', () => {
    expect(() => migrateLegacySession({ ...legacySession(), seedLength: 2 }, record())).toThrow(
      'migrating a fork-child legacy session is not supported by the prototype migrator',
    )
  })

  it('rejects duplicated legacy seq values', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[1]! }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow('legacy session seq 1 is duplicated')
  })

  it('rejects non-contiguous legacy seq values', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 5, sourceEventSeqs: [0] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy session seq 5 at index 3 must be contiguous from 0',
    )
  })

  it('rejects a negative seedLength', () => {
    expect(() => migrateLegacySession({ ...legacySession(), seedLength: -1 }, record())).toThrow(
      'legacy seedLength -1 must be a non-negative safe integer',
    )
  })

  it('rejects a fractional seedLength', () => {
    expect(() => migrateLegacySession({ ...legacySession(), seedLength: 1.5 }, record())).toThrow(
      'legacy seedLength 1.5 must be a non-negative safe integer',
    )
  })

  it('accepts a zero seedLength without a seed boundary', () => {
    const { file } = migrateLegacySession({ ...legacySession(), seedLength: 0 }, record())
    expect(file.session.seedBoundaryId).toBeUndefined()
  })

  it('rejects a legacy event with an empty type', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, type: '' }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 must carry a non-empty type',
    )
  })

  it('rejects a legacy event with a non-finite time', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, time: Number.NaN }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 must carry a non-negative safe integer time',
    )
  })

  it('rejects a legacy event without a data field', () => {
    const session = legacySession()
    const event = session.events[0]!
    const withoutData: LegacyEvent = { seq: event.seq, type: event.type, time: event.time, surfaceOp: 'append' } as LegacyEvent
    expect(() => migrateLegacySession({ ...session, events: [withoutData] }, record())).toThrow(
      'legacy event seq 0 must carry a data field',
    )
  })

  it('rejects a sourceEventSeq that names no migrated event', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 3, sourceEventSeqs: [98] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 references a non-earlier source seq 98',
    )
  })

  it('accepts legacy events carrying the ordinary append marker', () => {
    const session = legacySession()
    const events = session.events.map((event, index) => index < 2 ? { ...event, surfaceOp: 'append' as const } : event)
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.entries).toHaveLength(3)
  })

  it('rejects legacy events carrying a surfaceOp replace marker', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 3, surfaceOp: { op: 'replace', start: 0, end: 1 } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy surfaceOp replace events are not supported by the prototype migrator',
    )
  })

  it('preserves the append surfaceOp marker in the encoded blob', () => {
    const session = legacySession()
    const events = session.events.map((event, index) => index < 2 ? { ...event, surfaceOp: 'append' as const } : event)
    const { file } = migrateLegacySession({ ...session, events }, record())
    const blob = file.blobs.get('blob_0' as BlobId)
    expect(blob).toBeDefined()
    const parsed = JSON.parse(new TextDecoder().decode(blob)) as { surfaceOp?: unknown }
    expect(parsed.surfaceOp).toBe('append')
  })

  it('rejects a non-array sourceEventSeqs field', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, sourceEventSeqs: { length: 0 } as unknown as number[] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 sourceEventSeqs must be an array',
    )
  })

  it('rejects a legacy event with an unknown type', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'brand/new', time: 1, data: {} }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 has unknown type brand/new',
    )
  })

  it('rejects a surface event without a surfaceOp marker', () => {
    const session = legacySession()
    const { surfaceOp: _dropped, ...withoutMarker } = session.events[0]!
    const events = [{ ...withoutMarker }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy surface event seq 0 must carry a surfaceOp marker',
    )
  })

  it('rejects a log-only event carrying a surfaceOp marker', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'turn/start', time: 1, data: {}, surfaceOp: 'append' }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy log-only event seq 0 must not carry a surfaceOp marker',
    )
  })

  it('rejects a non-finite createdAt', () => {
    expect(() => migrateLegacySession({ ...legacySession(), createdAt: Number.NaN }, record())).toThrow(
      'legacy createdAt must be a non-negative safe integer',
    )
  })

  it('carries the legacy createdAt into the migrated record', () => {
    const { file } = migrateLegacySession({ ...legacySession(), createdAt: 12345 }, record())
    expect(file.session.createdAt).toBe(12345)
  })

  it('rejects a sourceEventSeq referenced twice', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 3, sourceEventSeqs: [0, 0] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 references a source seq twice',
    )
  })

  it('rejects an empty sourceEventSeqs on a non-assistant surface event', () => {
    const session = legacySession()
    const events = [...session.events, {
      seq: 3,
      type: 'user/message',
      time: 4,
      data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } },
      surfaceOp: 'append',
      sourceEventSeqs: [],
    }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 sourceEventSeqs must not be empty except on assistant/message',
    )
  })

  it('accepts an empty sourceEventSeqs on an assistant/message', () => {
    const session = legacySession()
    const events = [...session.events, {
      seq: 3,
      type: 'assistant/message',
      time: 4,
      data: {
        message: {
          id: 'm3',
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [],
    }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.references).toContainEqual({
      fromEventId: 'evt_sess_legacy_3',
      refName: 'sourceEventIds',
      toEventIds: [],
    })
  })

  it('rejects a negative sourceEventSeq', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 3, sourceEventSeqs: [-1] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 sourceEventSeqs must be non-negative safe integers',
    )
  })

  it('rejects a fractional sourceEventSeq', () => {
    const session = legacySession()
    const events = [...session.events, { ...session.events[2]!, seq: 3, sourceEventSeqs: [0.5] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 sourceEventSeqs must be non-negative safe integers',
    )
  })

  it('rejects an empty legacy id', () => {
    expect(() => migrateLegacySession({ ...legacySession(), id: '' }, record())).toThrow(
      'legacy id must be a non-empty string',
    )
  })

  it('rejects legacy events that are not an array', () => {
    expect(() => migrateLegacySession({ ...legacySession(), events: 'x' as unknown as LegacySession['events'] }, record())).toThrow(
      'legacy events must be an array',
    )
  })

  it('rejects legacy events that contain a null element', () => {
    const session = legacySession()
    const events = [null as unknown as LegacyEvent, ...session.events]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy events must be a dense array of objects',
    )
  })

  it('rejects sourceEventSeqs on a non-surface event', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'turn/start', time: 1, data: {}, sourceEventSeqs: [] }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 carries sourceEventSeqs but is not a surface event',
    )
  })

  it('migrates a log-only event without a surfaceOp field', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    const blob = JSON.parse(new TextDecoder().decode(file.blobs.get('blob_0' as BlobId))) as { surfaceOp?: unknown }
    expect(blob.surfaceOp).toBeUndefined()
  })

  it('migrates a step/start event without payload validation', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'step/start', time: 1, data: { turn: 1, step: 0 } }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.entries).toHaveLength(1)
  })

  it('rejects a nextEventCounter below the migrated event count', () => {
    expect(() => migrateLegacySession(legacySession(), { rootPage: 'page_sess_legacy' as PageId, revision: 'rev-0' as SessionRevision, nextEventCounter: 2 })).toThrow(
      'legacy migration nextEventCounter must sit above the migrated event count',
    )
  })

  it('carries the legacy header metadata into the record', () => {
    const { file } = migrateLegacySession({
      ...legacySession(),
      cwd: '/tmp', parentSession: 'sess_parent', origin: 'subagent', delegationDepth: 2, agentPreset: 'headless',
    }, record())
    expect(file.session).toMatchObject({
      cwd: '/tmp', parentSession: 'sess_parent', origin: 'subagent', delegationDepth: 2, agentPreset: 'headless',
    })
  })

  it('rejects a non-string legacy cwd', () => {
    expect(() => migrateLegacySession({ ...legacySession(), cwd: 5 as unknown as string }, record())).toThrow(
      'legacy cwd must be a string',
    )
  })

  it('rejects a negative legacy delegationDepth', () => {
    expect(() => migrateLegacySession({ ...legacySession(), delegationDepth: -1 }, record())).toThrow(
      'legacy delegationDepth must be a non-negative safe integer',
    )
  })

  it('rejects a non-string legacy parentSession', () => {
    expect(() => migrateLegacySession({ ...legacySession(), parentSession: 5 as unknown as string }, record())).toThrow(
      'legacy parentSession must be a string',
    )
  })

  it('rejects a non-string legacy origin', () => {
    expect(() => migrateLegacySession({ ...legacySession(), origin: 5 as unknown as string }, record())).toThrow(
      'legacy origin must be "subagent" when present',
    )
  })

  it('rejects a non-string legacy agentPreset', () => {
    expect(() => migrateLegacySession({ ...legacySession(), agentPreset: 5 as unknown as string }, record())).toThrow(
      'legacy agentPreset must be a string',
    )
  })

  it('rejects a null legacy session', () => {
    expect(() => migrateLegacySession(null as unknown as LegacySession, record())).toThrow(
      'legacy session must be an object',
    )
  })

  it('rejects a relative legacy cwd', () => {
    expect(() => migrateLegacySession({ ...legacySession(), cwd: 'relative/path' }, record())).toThrow(
      'legacy cwd must be an absolute path',
    )
  })

  it('rejects a user/message without an identified message', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, data: { content: 'x' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 user/message lacks an identified message',
    )
  })

  it('rejects a user/message with a wrong role', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, data: { id: 'm0', role: 'assistant', content: [], source: { kind: 'user' } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 user/message message must have role "user"',
    )
  })

  it('rejects an assistant/message without a model source', () => {
    const session = legacySession()
    const events = [{ ...session.events[1]!, data: { message: { id: 'm1', role: 'assistant', content: [], source: { kind: 'user' } } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 1 assistant/message message must have model source',
    )
  })

  it('rejects a tool/result without a tool source', () => {
    const session = legacySession()
    const events = [{ ...session.events[2]!, data: { message: { id: 'm2', role: 'user', content: [], source: { kind: 'user' } } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 2 tool/result message must have tool source',
    )
  })

  it('rejects a turn/start without a numeric turn', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'turn/start', time: 1, data: { id: 1 } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 turn/start must carry a safe-integer turn',
    )
  })

  it('rejects a turn/end without a numeric turn', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'turn/end', time: 1, data: { reason: { kind: 'success' } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 turn/end must carry a safe-integer turn',
    )
  })

  it('rejects a request/header without a provider/model config', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: {} } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header must carry a provider/model config',
    )
  })

  it('rejects a request/header whose data is not an object', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: 5 }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header must carry a provider/model config',
    )
  })

  it('rejects a request/header whose header is not an object', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: 'x' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header must carry a provider/model config',
    )
  })

  it('accepts a request/header with a provider/model config', () => {
    const session = legacySession()
    const events = [{
      seq: 0,
      type: 'request/header',
      time: 1,
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' },
    }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.entries).toHaveLength(1)
  })

  it('rejects a user/message whose data is not an object', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, data: 'x' }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 user/message lacks an identified message',
    )
  })

  it('rejects a user/message with an invalid source', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, data: { id: 'm0', role: 'user', content: [], source: 5 } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 user/message message has an invalid source',
    )
  })

  it('rejects a user/message with invalid content', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, data: { id: 'm0', role: 'user', content: 'x', source: { kind: 'user' } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 user/message message has invalid content',
    )
  })

  it('rejects an assistant/message whose model source lacks a provider', () => {
    const session = legacySession()
    const events = [{ ...session.events[1]!, data: { message: { id: 'm1', role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-chat' } } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 1 assistant/message message must have model source',
    )
  })

  it('rejects a tool/result whose message lacks a tool-result block', () => {
    const session = legacySession()
    const events = [{ ...session.events[2]!, data: { message: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'tool', callId: 'call-1' } } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 2 tool/result message must carry one tool-result block',
    )
  })

  it('rejects a tool/result whose tool-result block does not match the call id', () => {
    const session = legacySession()
    const events = [{ ...session.events[2]!, data: { message: { id: 'm2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'other', content: [] }], source: { kind: 'tool', callId: 'call-1' } } } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 2 tool/result message must carry one tool-result block',
    )
  })

  it('rejects a request/header with the obsolete fallback reason', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'fallback' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header uses unsupported legacy reason "fallback"',
    )
  })

  it('rejects a request/header with an invalid reasoningEffort', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' } }, reason: 'initial' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header has an invalid reasoningEffort',
    )
  })

  it('rejects a request/header with invalid adapterDefaults', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, adapterDefaults: { maxTokens: true } }, reason: 'initial' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header has invalid adapterDefaults',
    )
  })

  it('rejects a request/header with an unknown adapterDefaults key', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, adapterDefaults: { bogus: true } }, reason: 'initial' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header has invalid adapterDefaults',
    )
  })

  it('rejects a request/header whose adapterDefaults names an absent config field', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, adapterDefaults: { reasoningEffort: true } }, reason: 'initial' } }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 request/header has invalid adapterDefaults',
    )
  })

  it('accepts a request/header with valid adapterDefaults', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 100 }, adapterDefaults: { maxTokens: true } }, reason: 'initial' } }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.entries).toHaveLength(1)
  })

  it('rejects a negative nextEventCounter on an empty session', () => {
    const session = legacySession()
    const events: LegacyEvent[] = []
    expect(() => migrateLegacySession({ ...session, events }, { rootPage: 'page_sess_legacy' as PageId, revision: 'rev-0' as SessionRevision, nextEventCounter: -1 })).toThrow(
      'legacy migration nextEventCounter must sit above the migrated event count',
    )
  })

  it('rejects a sparse legacy events array', () => {
    const session = legacySession()
    const sparse = new Array<LegacyEvent>(3)
    sparse[0] = session.events[0]!
    sparse[2] = session.events[2]!
    expect(() => migrateLegacySession({ ...session, events: sparse }, record())).toThrow(
      'legacy events must be a dense array of objects',
    )
  })

  it('migrates an ignorable unknown-type event and preserves the marker', () => {
    const session = legacySession()
    const events = [...session.events, {
      seq: 3,
      type: 'vendor/plugin-info',
      time: 4,
      data: { note: 'external' },
      ignorable: true as const,
    }]
    const { file } = migrateLegacySession({ ...session, events }, record())
    expect(file.entries).toHaveLength(4)
    const blob = JSON.parse(new TextDecoder().decode(file.blobs.get('blob_3' as BlobId))) as { ignorable?: unknown }
    expect(blob.ignorable).toBe(true)
  })

  it('rejects an unknown-type event without the ignorable marker', () => {
    const session = legacySession()
    const events = [...session.events, { seq: 3, type: 'vendor/plugin-info', time: 4, data: {} }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 has unknown type vendor/plugin-info',
    )
  })

  it('rejects a known-type event carrying a non-true ignorable marker', () => {
    const session = legacySession()
    const events = [{ ...session.events[0]!, ignorable: false }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 ignorable must be true or absent',
    )
  })

  it('rejects a request/header-delta event even when ignorable', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'request/header-delta', time: 1, data: {}, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 uses unsupported legacy request/header-delta format',
    )
  })

  it('rejects a mode/set event even when ignorable', () => {
    // Core's envelope validation rejects mode/set unconditionally before the
    // ignorable marker is consulted, so a migrated file carrying it could
    // never be restored; the migrator must reject it up front like
    // request/header-delta.
    const session = legacySession()
    const events = [{ seq: 0, type: 'mode/set', time: 1, data: {}, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 uses unsupported legacy mode/set format',
    )
  })

  it('rejects a known-type event carrying data: undefined', () => {
    // A present-but-undefined data field would be dropped by JSON.stringify,
    // producing a blob without data that Session.fromRestore refuses. The
    // unknown ignorable type reaches the data-field check (surface-eligible
    // types would be rejected for their surfaceOp marker first).
    const session = legacySession()
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data: undefined, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 must carry a data field',
    )
  })

  it('rejects data that does not survive lossless JSON serialization', () => {
    // JSON.stringify silently drops undefined-valued keys; a migrated blob
    // would lose payload that Session.fromRestore then cannot replay.
    const session = legacySession()
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data: { keep: 1, drop: undefined }, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 data must survive lossless JSON serialization',
    )
  })

  it('rejects data containing negative zero', () => {
    // JSON.stringify rewrites -0 to 0, silently losing the sign.
    const session = legacySession()
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data: { n: -0 }, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 data must survive lossless JSON serialization',
    )
  })

  it('rejects an event carrying unknown top-level envelope fields', () => {
    const session = legacySession()
    const events = [{ seq: 0, type: 'user/message', time: 1, data: {}, extra: 1 }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 carries unknown envelope fields',
    )
  })

  it('rejects a legacy session carrying unknown top-level fields', () => {
    const session = legacySession()
    expect(() => migrateLegacySession({ ...session, bogus: 1 } as never, record())).toThrow(
      'legacy session carries unknown top-level fields',
    )
  })

  it('rejects data that is not a plain JSON value', () => {
    // A Map has no enumerable keys, so JSON.stringify turns it into {} and a
    // deep-equal of the round-trip would silently accept the loss.
    const session = legacySession()
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data: new Map([['k', 1]]), ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 data must survive lossless JSON serialization',
    )
  })

  it('rejects an array with extra own properties', () => {
    // JSON.stringify drops the extra property; isJsonValue rejects the array.
    const session = legacySession()
    const data = Object.assign([1], { meta: 2 })
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 data must survive lossless JSON serialization',
    )
  })

  it('rejects data carrying a symbol key', () => {
    // JSON.stringify silently drops symbol-keyed properties.
    const session = legacySession()
    const data: Record<string, unknown> = { a: 1 }
    ;(data as Record<PropertyKey, unknown>)[Symbol('x')] = 2
    const events = [{ seq: 0, type: 'vendor/plugin-info', time: 1, data, ignorable: true }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 0 data must survive lossless JSON serialization',
    )
  })

  it('migrates a log with a failed compaction transaction and the result imports', () => {
    // A legacy log can carry a failed compaction (start then end with error,
    // which has no summary by design). The migrated file has an empty side
    // table, so both markers are unclaimed; the import boundary must accept
    // the failed transaction via the entry-stream state machine instead of
    // rejecting it for lacking a side-table summary.
    const session = legacySession()
    const events = [
      ...session.events,
      { seq: 3, type: 'compaction/start', time: 4, data: { compactionId: 'compact_failed', turn: null } },
      { seq: 4, type: 'compaction/end', time: 5, data: { compactionId: 'compact_failed', turn: null, error: { kind: 'failed' } } },
    ]
    const { file } = migrateLegacySession({ ...session, events }, record())
    const loaded = deserializeSessionFile(serializeSessionFile(file))
    expect(loaded.entries.map(entry => entry.eventId)).toEqual(file.entries.map(entry => entry.eventId))
  })

  it('rejects a sparse sourceEventSeqs array', () => {
    const session = legacySession()
    const sparse = new Array<number>(2)
    sparse[0] = 0
    const events = [...session.events, { ...session.events[2]!, seq: 3, sourceEventSeqs: sparse }]
    expect(() => migrateLegacySession({ ...session, events }, record())).toThrow(
      'legacy event seq 3 sourceEventSeqs must be a dense array',
    )
  })
})

  it('keeps a migrated session appendable without blob id collision', () => {
    const { file } = migrateLegacySession(legacySession(), record())
    const engine = new SessionFormatEngine(new PageStore(), new SessionStore())
    engine.saveSession(file)
    const repository = new SessionRepository(engine)
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'user/message', time: 4, data: { text: 'after' }, surfaceOp: 'append',
    }))
    repository.append('sess_legacy' as SessionId, payload)
    const loaded = repository.loadSession('sess_legacy' as SessionId)
    expect(loaded.entries).toHaveLength(4)
    // Migration minted blob_0..2; the append must mint blob_3 (above the
    // migrated watermark) instead of colliding with an inherited blob.
    expect(loaded.entries[3]?.blobId).toBe('blob_3' as BlobId)
    expect(loaded.session.blobIdWatermark).toBe(3)
  })

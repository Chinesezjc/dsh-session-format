/**
 * Prototype one-time migration from the legacy seq-based session format to the
 * B+Tree + EventId session file format. Only legacy format version 0 is
 * understood; any other version is rejected. Events carrying an old-format
 * `surfaceOp` replace marker are rejected: the prototype migrator does not
 * collapse a replaced surface, and flattening it would mix shadowed messages
 * with the checkpoint in the physical sequence. The ordinary `append` marker
 * is order-preserving and accepted. A fork-child legacy session (`seedLength`
 * greater than zero) is rejected: without the parent's seq-to-EventId map the
 * inherited prefix cannot keep the parent EventIds the fork contract requires.
 * Event envelopes and `sourceEventSeqs` are validated instead of being
 * silently rewritten.
 * @module @deepseek-ai/dsh-session-format/migrate
 */

import { isAbsolute } from 'node:path'
import { isSurfaceEligibleType, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionFile } from './file.ts'
import type { BlobId, EventId, PageId, ReferenceRecord, SessionId, SessionRevision, StoredSessionRecord } from './index.ts'

/** Minimal legacy event shape understood by the prototype migrator. */
export interface LegacyEvent {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: unknown
  /** Marks an unknown-type event a reader may safely skip; only `true` or absent is accepted and preserved. */
  readonly ignorable?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether an unknown value carries a non-empty provider/model pair. */
function hasProviderModel(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
}

/** Adapter-default keys the core request-header validation accepts. */
const ALLOWED_ADAPTER_KEYS = new Set(['reasoningEffort', 'maxTokens'])

/**
 * Validate a request/header payload the way `Session.fromRestore` does, so a
 * migrated header can actually be restored: the config must carry a
 * provider/model pair, `reasoningEffort` (when present) must be a non-empty
 * string, and `adapterDefaults` must name only allowed keys with `true`
 * markers that the config actually carries. The obsolete `reason: 'fallback'`
 * vocabulary is rejected like the core header check does.
 * @param data - the legacy `request/header` payload.
 * @param seq - the legacy event seq, for error messages.
 */
function assertLegacyRequestHeader(data: unknown, seq: number): void {
  // The obsolete fallback reason lives at the data top level, matching the
  // core request-header rejection.
  if (isRecord(data) && data.reason === 'fallback') {
    throw new Error(`legacy event seq ${seq} request/header uses unsupported legacy reason "fallback"`)
  }
  const header = isRecord(data) ? data.header : undefined
  const headerRecord = isRecord(header) ? header : undefined
  const config = headerRecord?.config
  if (!hasProviderModel(config)) {
    throw new Error(`legacy event seq ${seq} request/header must carry a provider/model config`)
  }
  const configRecord = config as Record<string, unknown>
  const reasoningEffort = configRecord.reasoningEffort
  if (reasoningEffort !== undefined
    && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
    throw new Error(`legacy event seq ${seq} request/header has an invalid reasoningEffort`)
  }
  const adapterDefaults = headerRecord?.adapterDefaults
  if (adapterDefaults === undefined) return
  if (!isRecord(adapterDefaults)
    || Object.keys(adapterDefaults).some(key => !ALLOWED_ADAPTER_KEYS.has(key))
    || Object.values(adapterDefaults).some(marker => marker !== true)
    || adapterDefaults.reasoningEffort === true && configRecord.reasoningEffort === undefined
    || adapterDefaults.maxTokens === true && configRecord.maxTokens === undefined) {
    throw new Error(`legacy event seq ${seq} request/header has invalid adapterDefaults`)
  }
}

/**
 * Validate a legacy event's payload against the shapes `Session.fromRestore`
 * accepts, so a migrated file can actually be restored. The checks mirror the
 * core message-shape and turn-lifecycle validation (`packages/core/session`):
 * `user/message` carries the message directly in `data`, while
 * `assistant/message` and `tool/result` nest it under `data.message`; a turn
 * event must carry a numeric `turn`. Request headers must carry a config with
 * a provider/model pair. Anything else falls through to the envelope check.
 * @param type - the legacy event type.
 * @param data - the legacy event payload.
 * @param seq - the legacy event seq, for error messages.
 */
function assertLegacyPayload(type: string, data: unknown, seq: number): void {
  if (type === 'turn/start' || type === 'turn/end') {
    if (!isRecord(data) || typeof data.turn !== 'number' || !Number.isSafeInteger(data.turn)) {
      throw new Error(`legacy event seq ${seq} ${type} must carry a safe-integer turn`)
    }
    return
  }
  if (type === 'request/header') {
    assertLegacyRequestHeader(data, seq)
    return
  }
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return
  const record = isRecord(data) ? data : undefined
  const message = type === 'user/message' ? record : record?.message
  if (!isRecord(message) || typeof message.id !== 'string' || message.id === '') {
    throw new Error(`legacy event seq ${seq} ${type} lacks an identified message`)
  }
  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user'
  if (message.role !== expectedRole) {
    throw new Error(`legacy event seq ${seq} ${type} message must have role "${expectedRole}"`)
  }
  const source = message.source
  if (!isRecord(source) || typeof source.kind !== 'string' || source.kind === '') {
    throw new Error(`legacy event seq ${seq} ${type} message has an invalid source`)
  }
  if (!Array.isArray(message.content)) {
    throw new Error(`legacy event seq ${seq} ${type} message has invalid content`)
  }
  if (type === 'assistant/message') {
    if (source.kind !== 'model' || !hasProviderModel(source)) {
      throw new Error(`legacy event seq ${seq} assistant/message message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
    throw new Error(`legacy event seq ${seq} tool/result message must have tool source`)
  }
  const content = message.content as unknown[]
  const block = content[0]
  if (content.length !== 1 || !isRecord(block)
    || block.type !== 'tool-result'
    || !Array.isArray(block.content)
    || block.toolCallId !== source.callId) {
    throw new Error(`legacy event seq ${seq} tool/result message must carry one tool-result block`)
  }
}

/** Minimal legacy session shape understood by the prototype migrator. */
export interface LegacySession {
  readonly id: string
  readonly version: number
  readonly createdAt: number
  readonly seedLength?: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly events: readonly LegacyEvent[]
}

/** Result of one legacy migration. */
export interface MigrationResult {
  readonly file: SessionFile
  readonly seqToEventId: ReadonlyMap<number, EventId>
}

/**
 * Migrate a legacy seq-based session to the new file format.
 * `sourceEventSeqs` entries that do not name a migrated event are rejected;
 * the caller
 * supplies the root page identity and the initial revision, which belong to
 * the storage layer rather than to the format.
 * @param legacy - the legacy session payload.
 * @param record - the root page identity and initial revision for the new record.
 * @returns the migrated file and the seq-to-EventId map.
 */
export function migrateLegacySession(
  legacy: LegacySession,
  record: {
    readonly rootPage: PageId
    readonly revision: SessionRevision
    /** The migrated session's next EventId counter; the caller owns counter continuity. */
    readonly nextEventCounter: number
  },
): MigrationResult {
  // The durable boundary can pass non-object JSON; validate before field access.
  const legacyValue: unknown = legacy
  if (legacyValue === null || typeof legacyValue !== 'object') {
    throw new Error('legacy session must be an object')
  }
  // The record is rebuilt with only the known fields below; an unknown
  // top-level field would be dropped silently, so the boundary rejects it.
  if (!isRecord(legacyValue) || Object.keys(legacyValue).some(key => key !== 'id' && key !== 'version'
    && key !== 'createdAt' && key !== 'seedLength' && key !== 'cwd' && key !== 'parentSession'
    && key !== 'origin' && key !== 'delegationDepth' && key !== 'agentPreset' && key !== 'events')) {
    throw new Error('legacy session carries unknown top-level fields')
  }
  if (typeof legacy.id !== 'string' || legacy.id.length === 0) {
    throw new Error('legacy id must be a non-empty string')
  }
  if (!Array.isArray(legacy.events)) {
    throw new Error('legacy events must be an array')
  }
  // `Array.prototype.every` skips holes, so check own properties explicitly:
  // a sparse array must fail the dense-array contract instead of leaking
  // `undefined` into the event loop.
  for (let index = 0; index < legacy.events.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(legacy.events, index)) {
      throw new Error('legacy events must be a dense array of objects')
    }
    const event: unknown = legacy.events[index]
    if (event === null || typeof event !== 'object') {
      throw new Error('legacy events must be a dense array of objects')
    }
  }
  const events: readonly LegacyEvent[] = legacy.events
  if (legacy.version !== 0) {
    throw new Error(`unsupported legacy session version ${legacy.version}`)
  }
  for (const event of events) {
    const seq = event.seq
    if (typeof event.type !== 'string' || event.type.length === 0) {
      throw new Error(`legacy event seq ${seq} must carry a non-empty type`)
    }
    // The envelope is rebuilt with only the known fields below; a legacy
    // event carrying extra top-level fields would lose them silently, so the
    // durable/file boundary rejects them up front.
    if (Object.keys(event).some(key => key !== 'seq' && key !== 'type' && key !== 'time' && key !== 'data'
      && key !== 'sourceEventSeqs' && key !== 'surfaceOp' && key !== 'ignorable')) {
      throw new Error(`legacy event seq ${seq} carries unknown envelope fields`)
    }
    // Core's envelope validation rejects request/header-delta and mode/set
    // unconditionally, before the ignorable marker is consulted; the migrator
    // must do the same so a migrated file can actually be restored.
    if (event.type === 'request/header-delta') {
      throw new Error(`legacy event seq ${seq} uses unsupported legacy request/header-delta format`)
    }
    if (event.type === 'mode/set') {
      throw new Error(`legacy event seq ${seq} uses unsupported legacy mode/set format`)
    }
    // The ignorable marker is only valid as `true` or absent for every event
    // type, mirroring Session.fromRestore's envelope check.
    if (event.ignorable !== undefined && event.ignorable !== true) {
      throw new Error(`legacy event seq ${seq} ignorable must be true or absent`)
    }
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
      throw new Error('legacy surfaceOp replace events are not supported by the prototype migrator')
    }
    if (isSurfaceEligibleType(event.type)) {
      if (event.surfaceOp === undefined) {
        throw new Error(`legacy surface event seq ${seq} must carry a surfaceOp marker`)
      }
    } else if (event.surfaceOp !== undefined) {
      throw new Error(`legacy log-only event seq ${seq} must not carry a surfaceOp marker`)
    }
    if (event.sourceEventSeqs !== undefined) {
      if (!isSurfaceEligibleType(event.type)) {
        throw new Error(`legacy event seq ${seq} carries sourceEventSeqs but is not a surface event`)
      }
      if (!Array.isArray(event.sourceEventSeqs)) {
        throw new Error(`legacy event seq ${seq} sourceEventSeqs must be an array`)
      }
      if (event.sourceEventSeqs.length === 0 && event.type !== 'assistant/message') {
        throw new Error(`legacy event seq ${seq} sourceEventSeqs must not be empty except on assistant/message`)
      }
      // Sparse arrays would leak `undefined` through every() and later
      // serialize as null targets; require a dense array like the events row.
      for (let index = 0; index < event.sourceEventSeqs.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(event.sourceEventSeqs, index)) {
          throw new Error(`legacy event seq ${seq} sourceEventSeqs must be a dense array`)
        }
      }
      if (!event.sourceEventSeqs.every((sourceSeq: number) => Number.isSafeInteger(sourceSeq) && sourceSeq >= 0)) {
        throw new Error(`legacy event seq ${seq} sourceEventSeqs must be non-negative safe integers`)
      }
      if (new Set(event.sourceEventSeqs).size !== event.sourceEventSeqs.length) {
        throw new Error(`legacy event seq ${seq} references a source seq twice`)
      }
      for (const sourceSeq of event.sourceEventSeqs as number[]) {
        if (sourceSeq >= event.seq) {
          throw new Error(`legacy event seq ${seq} references a non-earlier source seq ${sourceSeq}`)
        }
      }
    }
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new Error(`legacy event seq ${seq} has unknown type ${event.type}`)
    }
    if (typeof event.time !== 'number' || !Number.isSafeInteger(event.time) || event.time < 0) {
      throw new Error(`legacy event seq ${seq} must carry a non-negative safe integer time`)
    }
    if (!('data' in event) || event.data === undefined) {
      throw new Error(`legacy event seq ${seq} must carry a data field`)
    }
    // The payload must be restorable: validate the known type's shape the way
    // Session.fromRestore does, so a migrated file cannot smuggle an
    // un-restorable event past the durable boundary.
    assertLegacyPayload(event.type, event.data, seq)
  }

  const seenSeqs = new Set<number>()
  events.forEach((event, index) => {
    if (seenSeqs.has(event.seq)) {
      throw new Error(`legacy session seq ${event.seq} is duplicated`)
    }
    if (event.seq !== index) {
      throw new Error(`legacy session seq ${event.seq} at index ${index} must be contiguous from 0`)
    }
    seenSeqs.add(event.seq)
  })

  const entries: SessionFile['entries'] = events.map((event, index) => ({
    order: index,
    eventId: `evt_${legacy.id}_${event.seq}` as EventId,
    blobId: `blob_${event.seq}` as BlobId,
  }))

  const blobs = new Map<BlobId, Uint8Array>()
  for (const event of events) {
    // JSON.stringify silently drops undefined values, rewrites NaN and -0,
    // and elides functions and symbols; an event whose data does not
    // round-trip would migrate to a blob that loses payload, so it is
    // rejected here.
    if (!isJsonValue(event.data)) {
      // isJsonValue rejects non-finite and -0 numbers, non-plain prototypes
      // (Map/Set/RegExp), symbol and non-enumerable keys, and extra array
      // properties — everything JSON.stringify would silently drop or rewrite.
      throw new Error(`legacy event seq ${event.seq} data must survive lossless JSON serialization`)
    }
    blobs.set(`blob_${event.seq}` as BlobId, new TextEncoder().encode(JSON.stringify({
      type: event.type,
      time: event.time,
      data: event.data,
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      ...(event.ignorable === undefined ? {} : { ignorable: event.ignorable }),
    })))
  }

  const seqToEventId = new Map<number, EventId>()
  for (const event of events) seqToEventId.set(event.seq, `evt_${legacy.id}_${event.seq}` as EventId)

  const references: ReferenceRecord[] = []
  for (const event of events) {
    if (event.sourceEventSeqs === undefined) continue
    const toEventIds = event.sourceEventSeqs.map((seq: number) => {
      // Contiguity plus the non-earlier check above guarantee every source
      // seq is already mapped, so the lookup cannot miss.
      return seqToEventId.get(seq) as EventId
    })
    references.push({
      fromEventId: `evt_${legacy.id}_${event.seq}` as EventId,
      refName: 'sourceEventIds',
      toEventIds,
    })
  }

  if (legacy.seedLength !== undefined
    && (!Number.isSafeInteger(legacy.seedLength) || legacy.seedLength < 0)) {
    throw new Error(`legacy seedLength ${legacy.seedLength} must be a non-negative safe integer`)
  }
  if (legacy.seedLength !== undefined && legacy.seedLength > 0) {
    throw new Error('migrating a fork-child legacy session is not supported by the prototype migrator')
  }

  if (typeof legacy.createdAt !== 'number' || !Number.isSafeInteger(legacy.createdAt) || legacy.createdAt < 0) {
    throw new Error('legacy createdAt must be a non-negative safe integer')
  }
  if (legacy.cwd !== undefined) {
    if (typeof legacy.cwd !== 'string') {
      throw new Error('legacy cwd must be a string')
    }
    if (!isAbsolute(legacy.cwd)) {
      throw new Error('legacy cwd must be an absolute path')
    }
  }
  if (legacy.parentSession !== undefined && typeof legacy.parentSession !== 'string') {
    throw new Error('legacy parentSession must be a string')
  }
  if (legacy.origin !== undefined && legacy.origin !== 'subagent') {
    throw new Error('legacy origin must be "subagent" when present')
  }
  if (legacy.agentPreset !== undefined && typeof legacy.agentPreset !== 'string') {
    throw new Error('legacy agentPreset must be a string')
  }
  if (legacy.delegationDepth !== undefined
    && (typeof legacy.delegationDepth !== 'number' || !Number.isSafeInteger(legacy.delegationDepth) || legacy.delegationDepth < 0)) {
    throw new Error('legacy delegationDepth must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(record.nextEventCounter)
    || record.nextEventCounter < 0
    || record.nextEventCounter < legacy.events.length) {
    throw new Error('legacy migration nextEventCounter must sit above the migrated event count')
  }
  const session: StoredSessionRecord = {
    sessionId: legacy.id as SessionId,
    formatVersion: 1,
    nextEventCounter: record.nextEventCounter,
    rootPage: record.rootPage,
    revision: record.revision,
    createdAt: legacy.createdAt,
    ...(legacy.cwd === undefined ? {} : { cwd: legacy.cwd }),
    ...(legacy.parentSession === undefined ? {} : { parentSession: legacy.parentSession as SessionId }),
    ...(legacy.origin === undefined ? {} : { origin: legacy.origin }),
    ...(legacy.delegationDepth === undefined ? {} : { delegationDepth: legacy.delegationDepth }),
    ...(legacy.agentPreset === undefined ? {} : { agentPreset: legacy.agentPreset }),
    backups: [],
  }

  return {
    file: {
      session,
      entries,
      blobs,
      references,
      compacted: [],
    },
    seqToEventId,
  }
}

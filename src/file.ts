/**
 * Prototype per-session file serialization for the B+Tree + EventId format.
 * This is a JSON container for the in-memory tree, persisted on disk through
 * the durable atomic file store; the durable page format will later replace
 * it with checksummed binary pages and 4KB/2MB/1GB segments.
 * @module @deepseek-ai/dsh-session-format/file
 */

import { isAbsolute } from 'node:path'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { SessionTree, type LeafEntry } from './btree.ts'
import { readSnapshotFile, writeSnapshotFile } from './file-store.ts'
import type {
  BlobId,
  CompactionId,
  CompactionSummary,
  EventId,
  ReferenceRecord,
  StoredSessionRecord,
} from './index.ts'

/** The top-level envelope keys Session.fromRestore accepts for one event. */
const ENVELOPE_KEYS = new Set(['type', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])

/**
 * Whether a token-usage record carries a non-finite or negative count.
 * @param usage - the token-usage record to check.
 * @returns whether any required count is non-finite or negative.
 */
export function invalidTokenUsage(usage: Record<string, unknown>): boolean {
  const bad = (value: unknown): boolean => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
  return bad(usage.inputTokens) || bad(usage.outputTokens)
    || (usage.totalTokens !== undefined && bad(usage.totalTokens))
    || (usage.cacheReadTokens !== undefined && bad(usage.cacheReadTokens))
    || (usage.cacheWriteTokens !== undefined && bad(usage.cacheWriteTokens))
    || (usage.reasoningTokens !== undefined && bad(usage.reasoningTokens))
}

/** Whether an envelope record fails the fixed marker envelope checks. */
function invalidMarkerEnvelope(record: Record<string, unknown>): boolean {
  return typeof record.time !== 'number'
    || !Number.isSafeInteger(record.time) || record.time < 0
    || (record.ignorable !== undefined && record.ignorable !== true)
    || Object.keys(record).some(key => !ENVELOPE_KEYS.has(key))
}

/** Whether an envelope carries surface metadata a log-only marker must not. */
function carriesSurfaceMetadata(record: Record<string, unknown>): boolean {
  return record.surfaceOp !== undefined || record.sourceEventSeqs !== undefined
}

/** One self-contained session file payload. */
export interface SessionFile {
  readonly session: StoredSessionRecord
  readonly entries: readonly LeafEntry[]
  readonly blobs: ReadonlyMap<BlobId, Uint8Array>
  readonly references: readonly ReferenceRecord[]
  readonly compacted: readonly CompactionSummary[]
}

interface SerializedSessionFile {
  readonly format: 'dsh-session-format'
  readonly version: 1
  readonly session: StoredSessionRecord
  readonly entries: readonly LeafEntry[]
  readonly blobs: Readonly<Record<string, { readonly base64: string }>>
  readonly references: readonly ReferenceRecord[]
  readonly compacted: readonly CompactionSummary[]
}

/**
 * Validate a summary content block: known discriminants carry their required fields.
 * @param value - the block to validate.
 * @returns true when the block is a record with a string type tag and the
 * required fields of its known discriminant.
 */
export function isContentBlock(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'reasoning') return typeof value.text === 'string'
  if (value.type === 'tool-call') {
    return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.arguments === 'string'
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isBackupRecord(value: unknown): boolean {
  if (!isRecord(value) || typeof value.rootPage !== 'string') return false
  for (const field of ['referencesPage', 'blobMapPage', 'compactedPage', 'seedBoundaryId'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  return true
}

function validateSession(value: unknown): StoredSessionRecord {
  if (!isRecord(value)) throw new Error('session file session must be an object')
  for (const field of ['sessionId', 'rootPage', 'revision'] as const) {
    if (typeof value[field] !== 'string') throw new Error(`session file session ${field} must be a string`)
  }
  if (typeof value.formatVersion !== 'number') throw new Error('session file session formatVersion must be a number')
  if (value.formatVersion !== 1) throw new Error('session file session formatVersion must be 1')
  if (!Array.isArray(value.backups) || !value.backups.every(isBackupRecord)) {
    throw new Error('session file session backups must be an array of backup records')
  }
  for (const field of ['seedBoundaryId', 'blobMapPage', 'referencesPage', 'compactedPage', 'cwd', 'parentSession', 'agentPreset'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error(`session file session ${field} must be a string`)
    }
  }
  if (value.origin !== undefined && value.origin !== 'subagent') {
    throw new Error('session file session origin must be "subagent" when present')
  }
  if (typeof value.cwd === 'string' && !isAbsolute(value.cwd)) {
    throw new Error('session file session cwd must be an absolute path')
  }
  if (value.delegationDepth !== undefined
    && (typeof value.delegationDepth !== 'number' || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0)) {
    throw new Error('session file session delegationDepth must be a non-negative safe integer')
  }
  if (value.createdAt !== undefined
    && (typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0)) {
    throw new Error('session file session createdAt must be a non-negative safe integer')
  }
  if (typeof value.nextEventCounter !== 'number'
    || !Number.isSafeInteger(value.nextEventCounter)
    || value.nextEventCounter < 0) {
    throw new Error('session file session nextEventCounter must be a non-negative safe integer')
  }
  if (value.blobIdWatermark !== undefined
    && (typeof value.blobIdWatermark !== 'number' || !Number.isSafeInteger(value.blobIdWatermark) || value.blobIdWatermark < 0)) {
    throw new Error('session file session blobIdWatermark must be a non-negative safe integer')
  }
  if (value.usedEventBindings !== undefined) {
    const bindings = value.usedEventBindings
    if (!isRecord(bindings)
      || Object.values(bindings).some(binding => typeof binding !== 'string')) {
      throw new Error('session file session usedEventBindings must be a string map when present')
    }
  }
  const record = value as unknown as StoredSessionRecord
  // Rebuild the durable binding table as a Map from the serialized object.
  if (record.usedEventBindings !== undefined) {
    return {
      ...record,
      usedEventBindings: new Map(Object.entries(record.usedEventBindings as unknown as Record<string, string>)),
    } as unknown as StoredSessionRecord
  }
  return record
}

function validateEntries(value: unknown): LeafEntry[] {
  if (!Array.isArray(value)) throw new Error('session file entries must be an array')
  const entries: LeafEntry[] = []
  const seenEventIds = new Set<EventId>()
  let previousOrder: number | undefined
  for (const item of value) {
    if (!isRecord(item)) throw new Error('session file entry must be an object')
    if (typeof item.order !== 'number' || !Number.isFinite(item.order)) {
      throw new Error('session file entry order must be a finite number')
    }
    if (typeof item.eventId !== 'string') throw new Error('session file entry eventId must be a string')
    if (typeof item.blobId !== 'string') throw new Error('session file entry blobId must be a string')
    if (previousOrder !== undefined && item.order <= previousOrder) {
      throw new Error('session file entries must be sorted by strictly increasing order')
    }
    if (seenEventIds.has(item.eventId as EventId)) {
      throw new Error(`session file entry eventId ${item.eventId} is duplicated`)
    }
    previousOrder = item.order
    seenEventIds.add(item.eventId as EventId)
    entries.push({ order: item.order, eventId: item.eventId as EventId, blobId: item.blobId as BlobId })
  }
  return entries
}

function validateBlobs(value: unknown): Map<BlobId, Uint8Array> {
  if (!isRecord(value)) throw new Error('session file blobs must be an object')
  const blobs = new Map<BlobId, Uint8Array>()
  for (const [blobId, encoded] of Object.entries(value)) {
    if (!isRecord(encoded)) throw new Error(`session file blob ${blobId} must be an object`)
    const base64 = encoded.base64
    if (typeof base64 !== 'string') throw new Error(`session file blob ${blobId} base64 must be a string`)
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw new Error(`session file blob ${blobId} is not valid base64`)
    blobs.set(blobId as BlobId, bytes)
  }
  return blobs
}

function validateReferences(value: unknown): ReferenceRecord[] {
  if (!Array.isArray(value)) throw new Error('session file references must be an array')
  const references: ReferenceRecord[] = []
  const seenKeys = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) throw new Error('session file reference must be an object')
    if (typeof item.fromEventId !== 'string') throw new Error('session file reference fromEventId must be a string')
    if (typeof item.refName !== 'string') throw new Error('session file reference refName must be a string')
    if (!isStringArray(item.toEventIds)) throw new Error('session file reference toEventIds must be a string array')
    const key = `${item.fromEventId}\u0000${item.refName}`
    if (seenKeys.has(key)) {
      throw new Error(`session file reference ${item.fromEventId}/${item.refName} is duplicated`)
    }
    if (new Set(item.toEventIds).size !== item.toEventIds.length) {
      throw new Error(`session file reference ${item.fromEventId}/${item.refName} has duplicate targets`)
    }
    seenKeys.add(key)
    references.push({
      fromEventId: item.fromEventId as EventId,
      refName: item.refName,
      toEventIds: item.toEventIds as EventId[],
    })
  }
  return references
}

function validateCompacted(value: unknown): CompactionSummary[] {
  if (!Array.isArray(value)) throw new Error('session file compacted must be an array')
  const compacted: CompactionSummary[] = []
  for (const item of value) {
    if (!isRecord(item)) throw new Error('session file compaction summary must be an object')
    if (typeof item.compactionId !== 'string' || item.compactionId.length === 0) {
      throw new Error('session file compaction summary compactionId must be a non-empty string')
    }
    if (typeof item.checkpointEventId !== 'string') {
      throw new Error('session file compaction summary checkpointEventId must be a string')
    }
    const markers = item.markerEventIds
    if (!isRecord(markers)
      || typeof markers.startEventId !== 'string'
      || typeof markers.summaryEventId !== 'string'
      || typeof markers.endEventId !== 'string') {
      throw new Error('session file compaction summary markerEventIds must have string start, summary, and end ids')
    }
    const range = item.shadowedRange
    if (!isRecord(range) || typeof range.startId !== 'string' || typeof range.endId !== 'string') {
      throw new Error('session file compaction summary shadowedRange must have string startId and endId')
    }
    if (!isStringArray(item.shadowedIds) || item.shadowedIds.length === 0) throw new Error('session file compaction summary shadowedIds must be a non-empty string array')
    // The range endpoints are retired events: they must appear in shadowedIds,
    // or the high-water computation and later compactions would not see them.
    const shadowedIdSet = new Set(item.shadowedIds as EventId[])
    if (!shadowedIdSet.has(range.startId as EventId) || !shadowedIdSet.has(range.endId as EventId)) {
      throw new Error('session file compaction summary shadowedRange endpoints must appear in shadowedIds')
    }
    if (!Array.isArray(item.summary) || !item.summary.every(isContentBlock) || !isJsonValue(item.summary)) {
      throw new Error('session file compaction summary summary must be a content block array')
    }
    if (typeof item.shadowedTokenCount !== 'number'
      || !Number.isSafeInteger(item.shadowedTokenCount)
      || item.shadowedTokenCount < 0) {
      throw new Error('session file compaction summary shadowedTokenCount must be a non-negative safe integer')
    }
    if (typeof item.provider !== 'string' || typeof item.model !== 'string') {
      throw new Error('session file compaction summary provider and model must be strings')
    }
    if (item.sourceCommandId !== undefined
      && (typeof item.sourceCommandId !== 'string' || item.sourceCommandId.length === 0)) {
      throw new Error('session file compaction summary sourceCommandId must be a non-empty string')
    }
    if (item.maxTokens !== undefined && (typeof item.maxTokens !== 'number' || !Number.isSafeInteger(item.maxTokens) || item.maxTokens < 0)) {
      throw new Error('session file compaction summary maxTokens must be a non-negative safe integer')
    }
    if (item.usage !== undefined
      && (!isRecord(item.usage) || invalidTokenUsage(item.usage))) {
      throw new Error('session file compaction summary usage must be a token usage record')
    }
    if (item.llmStreamCall !== undefined && item.llmStreamCall !== true) {
      throw new Error('session file compaction summary llmStreamCall must be true or absent')
    }
    const seqRange = item.shadowedSeqRange
    if (!isRecord(seqRange) || typeof seqRange.start !== 'number' || typeof seqRange.end !== 'number') {
      throw new Error('session file compaction summary shadowedSeqRange must be a numeric range')
    }
    if (!Number.isSafeInteger(seqRange.start) || !Number.isSafeInteger(seqRange.end)
      || seqRange.start < 0 || seqRange.end < 0) {
      throw new Error('session file compaction summary shadowedSeqRange must be a non-negative safe integer range')
    }
    const shadowedSeqs = item.shadowedSeqs
    /* jscpd:ignore-start -- seq-array validation shared with the compaction blob checker; each side reports its own boundary's message. */
    if (!Array.isArray(shadowedSeqs)
      || shadowedSeqs.length === 0
      || !shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      || shadowedSeqs[0] !== seqRange.start
      || shadowedSeqs[shadowedSeqs.length - 1] !== seqRange.end) {
      throw new Error('session file compaction summary shadowedSeqs must be a non-empty non-negative seq array spanning shadowedSeqRange')
    }
    /* jscpd:ignore-end */
    if (item.rawOutput !== undefined
      && (!Array.isArray(item.rawOutput) || !item.rawOutput.every(isContentBlock) || !isJsonValue(item.rawOutput))) {
      throw new Error('session file compaction summary rawOutput must be a content block array')
    }
    if (item.llmStreamCall === true && item.rawOutput === undefined) {
      throw new Error('session file compaction summary rawOutput is required when llmStreamCall is true')
    }
    compacted.push({
      compactionId: item.compactionId as CompactionId,
      checkpointEventId: item.checkpointEventId as EventId,
      markerEventIds: {
        startEventId: markers.startEventId as EventId,
        summaryEventId: markers.summaryEventId as EventId,
        endEventId: markers.endEventId as EventId,
      },
      shadowedRange: { startId: range.startId as EventId, endId: range.endId as EventId },
      shadowedIds: item.shadowedIds as EventId[],
      shadowedSeqRange: { start: seqRange.start, end: seqRange.end },
      shadowedSeqs: item.shadowedSeqs,
      summary: item.summary,
      shadowedTokenCount: item.shadowedTokenCount,
      provider: item.provider,
      model: item.model,
      ...(item.sourceCommandId === undefined ? {} : { sourceCommandId: item.sourceCommandId }),
      ...(item.maxTokens === undefined ? {} : { maxTokens: item.maxTokens }),
      ...(item.usage === undefined ? {} : { usage: item.usage }),
      ...(item.llmStreamCall === undefined ? {} : { llmStreamCall: item.llmStreamCall }),
      ...(item.rawOutput === undefined ? {} : { rawOutput: item.rawOutput }),
    } as unknown as CompactionSummary)
  }
  return compacted
}

/**
 * Serialize a session file to bytes.
 * @param file - the session file to serialize.
 * @returns the serialized file bytes.
 */
export function serializeSessionFile(file: SessionFile): Uint8Array {
  // Object.fromEntries creates own properties even for a BlobId like
  // "__proto__", which a plain object literal would silently drop.
  const blobs = Object.fromEntries(
    [...file.blobs].map(([blobId, bytes]) => [blobId, { base64: Buffer.from(bytes).toString('base64') }]),
  )
  // A Map does not survive JSON.stringify as a map, so the durable binding
  // table is serialized as a plain object and rebuilt on read.
  const session = file.session.usedEventBindings === undefined
    ? { ...file.session }
    : { ...file.session, usedEventBindings: Object.fromEntries(file.session.usedEventBindings) } as unknown as StoredSessionRecord
  const payload: SerializedSessionFile = {
    format: 'dsh-session-format',
    version: 1,
    session,
    entries: file.entries,
    blobs,
    references: file.references,
    compacted: file.compacted,
  }
  return new TextEncoder().encode(JSON.stringify(payload, null, 2))
}

/**
 * Deserialize a session file from bytes.
 * This is a durable/file boundary: every section is validated structurally and
 * cross-references are checked (entries name existing blobs, references name
 * existing events) before the payload is trusted.
 * @param data - the serialized file bytes.
 * @returns the validated session file.
 */
export function deserializeSessionFile(data: Uint8Array): SessionFile {
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  if (!isRecord(payload) || payload.format !== 'dsh-session-format' || payload.version !== 1) {
    throw new Error('unsupported session file format')
  }
  const session = validateSession(payload.session)
  const entries = validateEntries(payload.entries)

  const blobs = validateBlobs(payload.blobs)
  const references = validateReferences(payload.references)
  const compacted = validateCompacted(payload.compacted)
  const usedEventIds = [
    ...entries.map(entry => entry.eventId),
    ...compacted.flatMap(summary => [summary.checkpointEventId, ...summary.shadowedIds]),
    ...(session.usedEventBindings === undefined ? [] : [...session.usedEventBindings.keys()]),
  ]
  // The counter is per-session: EventIds carry the session's own prefix, and
  // a forked child inherits parent-prefixed events it must not count against
  // its own counter, so only ids in this session's namespace feed the
  // high-water mark.
  const sessionPrefix = `evt_${session.sessionId}_`
  const highestUsedEventId = usedEventIds.reduce((max, id) => {
    const suffix = id.startsWith(sessionPrefix) ? id.slice(sessionPrefix.length) : ''
    const value = /^\d+$/.test(suffix) ? Number(suffix) : -1
    return value > max ? value : max
  }, -1)
  if (session.nextEventCounter <= highestUsedEventId) {
    throw new Error('session file session nextEventCounter must exceed the highest used EventId number')
  }

  for (const entry of entries) {
    if (!blobs.has(entry.blobId)) {
      throw new Error(`session file entry ${entry.eventId} references missing blob ${entry.blobId}`)
    }
  }
  // A live entry's binding must agree with the durable binding table; an
  // archive that binds the same EventId differently is a self-contradictory
  // identity history and must not be accepted at the file boundary.
  if (session.usedEventBindings !== undefined) {
    for (const entry of entries) {
      const bound = session.usedEventBindings.get(entry.eventId)
      if (bound !== undefined && bound !== entry.blobId) {
        throw new Error(`session file event ${entry.eventId} binding conflicts with the file's usedEventBindings`)
      }
    }
  }
  const entryEventIds = new Set(entries.map(entry => entry.eventId))
  const entryRankById = new Map(entries.map((entry, index) => [entry.eventId, index]))
  const summaryByMarkerId = new Map<EventId, CompactionSummary>()
  for (const summary of compacted) {
    for (const markerId of [
      summary.checkpointEventId,
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]) {
      const previous = summaryByMarkerId.get(markerId)
      if (previous !== undefined && previous !== summary) {
        throw new Error(`session file compaction marker ${markerId} is shared by two summaries`)
      }
      summaryByMarkerId.set(markerId, summary)
    }
  }
  // A rank-only nesting/interleave pre-check runs before the per-summary blob
  // scans: an adversarial file whose claimed brackets overlap is rejected here
  // in O(m log m) rank math instead of paying O(n^2) blob parses first.
  {
    const spans: Array<{ readonly start: number; readonly end: number }> = []
    for (const summary of compacted) {
      const start = entryRankById.get(summary.markerEventIds.startEventId)
      const end = entryRankById.get(summary.markerEventIds.endEventId)
      /* v8 ignore next 2 -- marker presence and order are validated per summary below */
      if (start === undefined || end === undefined) continue
      spans.push({ start, end })
    }
    spans.sort((a, b) => a.start - b.start)
    let previousEnd: number | undefined
    for (const span of spans) {
      if (previousEnd !== undefined && span.start < previousEnd) {
        throw new Error('session file compaction summaries must not nest or interleave')
      }
      previousEnd = span.end
    }
  }
  // Built once: every summary below resolves its marker entries through this
  // map, so a file with many compactions does not rebuild it per summary.
  const markerEntryById = new Map(entries.map(entry => [entry.eventId, entry]))
  // The open-turn cursor before each rank, computed in one forward pass so the
  // per-summary start-marker checks do not re-scan the prefix per summary.
  const turnCursorBeforeRank: Array<number | null> = []
  {
    let cursor: number | null = null
    for (const entry of entries) {
      turnCursorBeforeRank.push(cursor)
      /* jscpd:ignore-start -- turn-cursor walk shared with the entry-stream transaction scan */
      let envelope: unknown
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blobs.get(entry.blobId)))
      } catch {
        continue
      }
      const eventType = isRecord(envelope) ? envelope.type : undefined
      const eventData = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined
      if (eventType === 'turn/start') {
        cursor = eventData?.turn as number | null ?? null
      } else if (eventType === 'turn/end') {
        cursor = null
      }
      /* jscpd:ignore-end */
    }
  }
  if (session.seedBoundaryId !== undefined && !entryEventIds.has(session.seedBoundaryId)) {
    throw new Error(`session file seedBoundaryId ${session.seedBoundaryId} targets a missing event`)
  }
  for (const summary of compacted) {
    if (!entryEventIds.has(summary.checkpointEventId)) {
      throw new Error(`session file compaction summary ${summary.compactionId} targets missing checkpoint event ${summary.checkpointEventId}`)
    }
    const markerIds = [
      summary.checkpointEventId,
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]
    if (new Set(markerIds).size !== markerIds.length) {
      throw new Error(`session file compaction summary ${summary.compactionId} markers must be pairwise distinct`)
    }
    for (const markerId of [
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]) {
      if (!entryEventIds.has(markerId)) {
        throw new Error(`session file compaction summary ${summary.compactionId} targets missing marker event ${markerId}`)
      }
    }
    // The transaction opens with start, closes with end, and the summary and
    // checkpoint land between them; a reordered archive would replay as an
    // end closing a transaction the checkpoint never opened. Structural order
    // is checked before the marker blob contents so a reordered archive is
    // rejected on its shape, not on a coincidental blob-type mismatch. The
    // checkpoint must also directly follow the summary: the replay path pairs
    // the checkpoint with the preceding summary event.
    const startRank = entryRankById.get(summary.markerEventIds.startEventId)
    const summaryRank = entryRankById.get(summary.markerEventIds.summaryEventId)
    const checkpointRank = entryRankById.get(summary.checkpointEventId)
    const endRank = entryRankById.get(summary.markerEventIds.endEventId)
    if (startRank === undefined || summaryRank === undefined
      || checkpointRank === undefined || endRank === undefined
      || !(startRank < summaryRank && summaryRank < checkpointRank && checkpointRank < endRank)
      || checkpointRank !== summaryRank + 1) {
      throw new Error(`session file compaction summary ${summary.compactionId} markers must appear in start, summary, checkpoint, end order`)
    }
    // The marker events must actually be the transaction's events: a forged
    // archive could point a summary at unrelated blobs, and fork/compaction
    // would then trust fake bracket boundaries or skip surface validation.
    const markerBlobIds = [
      summary.checkpointEventId,
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]
    // Each marker's initiating command id, collected so the group can be
    // checked for the same consistency dsh-compaction's
    // validateSourceCommandId enforces at replay. The start/end turns are
    // collected alongside for the same-owner check below.
    const markerSourceCommands = new Map<EventId, unknown>()
    const markerTurns = new Map<EventId, unknown>()
    for (const markerId of markerBlobIds) {
      // The checkpoint and marker existence checks above guarantee presence.
      const markerEntry = markerEntryById.get(markerId) as { readonly blobId: BlobId }
      const markerBytes = blobs.get(markerEntry.blobId)
      let markerEnvelope: unknown
      try {
        markerEnvelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes))
      } catch {
        throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} is not a JSON envelope`)
      }
      const record = isRecord(markerEnvelope) ? markerEnvelope : undefined
      const markerData = isRecord(record?.data) ? record.data : undefined
      if (record === undefined || invalidMarkerEnvelope(record)) {
        // The write side requires a non-negative safe-integer time on every
        // event envelope and an ignorable marker that is true or absent, and
        // Session.fromRestore rejects any envelope key outside its whitelist;
        // the import boundary must accept only what restore can replay.
        throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} has an invalid envelope`)
      }
      if (markerId === summary.checkpointEventId) {
        // The checkpoint is a user/message carrying the compaction's
        // provenance in data.source and a replace surfaceOp with exactly
        // { op, start, end } and non-negative safe integer endpoints (the
        // shape core's isReplaceOp and surface replay require). It must also
        // be a restorable user message: Session.fromRestore requires an
        // identified message with role/content, and foldSurface's
        // assertProvenance requires sourceEventSeqs to cite every shadowed
        // surface node.
        const source = isRecord(markerData) ? markerData.source : undefined
        markerSourceCommands.set(markerId, isRecord(source) ? source.sourceCommandId : undefined)
        const surfaceOp = record.surfaceOp
        const envelopeSourceSeqs = record.sourceEventSeqs
        const envelopeSeqSet = Array.isArray(envelopeSourceSeqs) ? new Set(envelopeSourceSeqs as number[]) : undefined
        if (record.type !== 'user/message'
          || !isRecord(markerData)
          || typeof markerData.id !== 'string' || markerData.id === ''
          || markerData.role !== 'user'
          || !Array.isArray(markerData.content)
          || !isRecord(source)
          || source.kind !== 'plugin'
          || source.plugin !== 'compact'
          || source.compactionId !== summary.compactionId
          || !isRecord(surfaceOp)
          || surfaceOp.op !== 'replace'
          /* jscpd:ignore-start -- replace-surfaceOp check shared with compaction.ts */
          || Object.keys(surfaceOp).length !== 3
          || typeof surfaceOp.start !== 'number'
          || !Number.isSafeInteger(surfaceOp.start)
          || surfaceOp.start < 0
          || typeof surfaceOp.end !== 'number'
          || !Number.isSafeInteger(surfaceOp.end)
          || surfaceOp.end < 0
          /* jscpd:ignore-end */
          || surfaceOp.start !== summary.shadowedSeqRange.start
          || surfaceOp.end !== summary.shadowedSeqRange.end
          || !Array.isArray(envelopeSourceSeqs)
          || envelopeSourceSeqs.length === 0
          || !envelopeSourceSeqs.every((seq: unknown) => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
          || envelopeSeqSet === undefined
          || envelopeSeqSet.size !== envelopeSourceSeqs.length
          || !summary.shadowedSeqs.every(seq => envelopeSeqSet.has(seq))) {
          throw new Error(`session file compaction summary ${summary.compactionId} checkpoint marker event ${markerId} has an invalid envelope`)
        }
      } else {
        const expected = markerId === summary.markerEventIds.startEventId
          ? 'compaction/start'
          : markerId === summary.markerEventIds.summaryEventId
            ? 'compaction/summary'
            : 'compaction/end'
        if (record.type !== expected || markerData?.compactionId !== summary.compactionId) {
          throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} must be a ${expected} event of the same compaction`)
        }
        // The bracket markers are log-only records, not surface events: a
        // surfaceOp or sourceEventSeqs on them would be rejected by the
        // surface validation at restore.
        if (record.surfaceOp !== undefined || record.sourceEventSeqs !== undefined) {
          throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} must not carry surface metadata`)
        }
        if (markerId === summary.markerEventIds.endEventId && markerData.error !== undefined) {
          // The side table records the transaction as committed and its events
          // physically removed; a failed end marker would contradict that.
          throw new Error(`session file compaction summary ${summary.compactionId} end marker must not record a failed compaction`)
        }
        markerSourceCommands.set(markerId, markerData.sourceCommandId)
        if (markerId !== summary.markerEventIds.summaryEventId) {
          markerTurns.set(markerId, markerData.turn)
          if (!isRecord(markerData) || (markerData.turn !== null && typeof markerData.turn !== 'number')) {
            // Replay's validateOwner reads the start/end owner, so a marker
            // that omits its turn would fail at replay even though type and
            // compactionId match.
            throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} must carry a numeric or null turn`)
          }
        }
        if (markerId === summary.markerEventIds.summaryEventId) {
          // The compacted side table mirrors the summary event payload; a
          // mismatch would make the import and the replay express two
          // different facts about the same transaction.
          const blobSummary = markerData.summary
          const blobShadowedRange = markerData.shadowedRange
          const blobShadowedSeqs = markerData.shadowedSeqs
          const blobShadowedTokenCount = markerData.shadowedTokenCount
          const blobProvider = markerData.provider
          const blobModel = markerData.model
          const blobSourceCommandId = markerData.sourceCommandId
          const blobMaxTokens = markerData.maxTokens
          const blobUsage = markerData.usage
          const blobLlmStreamCall = markerData.llmStreamCall
          const blobRawOutput = markerData.rawOutput
          if (!isRecord(blobShadowedRange)
            || blobShadowedRange.start !== summary.shadowedSeqRange.start
            || blobShadowedRange.end !== summary.shadowedSeqRange.end
            || !Array.isArray(blobShadowedSeqs)
            || blobShadowedSeqs.length !== summary.shadowedSeqs.length
            || blobShadowedSeqs.some((seq, index) => seq !== summary.shadowedSeqs[index])
            || blobShadowedTokenCount !== summary.shadowedTokenCount
            || blobProvider !== summary.provider
            || blobModel !== summary.model
            || blobSummary === undefined
            || !Array.isArray(blobSummary)
            || !deepEqualJson(blobSummary, summary.summary)
            || !deepEqualJson(blobSourceCommandId, summary.sourceCommandId)
            || !deepEqualJson(blobMaxTokens, summary.maxTokens)
            || !deepEqualJson(blobUsage, summary.usage)
            || !deepEqualJson(blobLlmStreamCall, summary.llmStreamCall)
            || !deepEqualJson(blobRawOutput, summary.rawOutput)) {
            throw new Error(`session file compaction summary ${summary.compactionId} payload does not match the summary marker event`)
          }
        }
      }
    }
    // The whole marker group must share one sourceCommandId: dsh-compaction's
    // validateSourceCommandId requires each marker and the checkpoint source
    // to match the start marker (all absent for automatic compactions, or all
    // the same id for manual ones). The side table carries the same fact, so
    // the group must also agree with it; validateCompacted already guarantees
    // the side-table value is non-empty when present, which the equality then
    // extends to every marker.
    const firstCommand = markerSourceCommands.get(summary.markerEventIds.startEventId)
    if (firstCommand !== summary.sourceCommandId) {
      throw new Error(`session file compaction summary ${summary.compactionId} marker events must carry a consistent sourceCommandId`)
    }
    for (const [markerId, sourceCommandId] of markerSourceCommands) {
      if (sourceCommandId !== firstCommand) {
        throw new Error(`session file compaction summary ${summary.compactionId} marker event ${markerId} must carry a consistent sourceCommandId`)
      }
    }
    // The start and end markers must name the same turn: replay's
    // validateOwner requires 'compaction/end owner ... does not match
    // compaction/start owner', and validateTurnBoundary forbids turn
    // boundaries crossing an open compaction, so the bracket cannot enclose a
    // turn/start or turn/end either. A numeric marker turn must also sit
    // inside an actually open turn at the start-marker position — replay's
    // validateOwner compares the owner against a single cursor set by the last
    // turn/start and cleared by any turn/end, so a forged numeric turn with no
    // open turn at that position would be rejected at replay.
    const startTurnValue = markerTurns.get(summary.markerEventIds.startEventId)
    if (markerTurns.get(summary.markerEventIds.startEventId)
      !== markerTurns.get(summary.markerEventIds.endEventId)) {
      throw new Error(`session file compaction summary ${summary.compactionId} start and end markers must carry the same turn`)
    }
    const openTurnCursor = turnCursorBeforeRank[startRank] ?? null
    if (typeof startTurnValue === 'number' && openTurnCursor !== startTurnValue) {
      throw new Error(`session file compaction summary ${summary.compactionId} start marker must sit inside an open turn`)
    }
    if (startTurnValue === null && openTurnCursor !== null) {
      throw new Error(`session file compaction summary ${summary.compactionId} start marker must belong to the turn enclosing the range`)
    }
    for (let rank = startRank + 1; rank < endRank; rank += 1) {
      const candidate = entries[rank] as LeafEntry
      let candidateEnvelope: unknown
      try {
        candidateEnvelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blobs.get(candidate.blobId)))
      } catch {
        continue
      }
      if (isRecord(candidateEnvelope)
        && (candidateEnvelope.type === 'turn/start' || candidateEnvelope.type === 'turn/end')) {
        throw new Error(`session file compaction summary ${summary.compactionId} bracket crosses turn boundary event ${candidate.eventId}`)
      }
      if (isRecord(candidateEnvelope) && candidateEnvelope.type === 'session/end-seed') {
        // Replay's invariant clears the compaction trace at an end-seed, so a
        // bracket crossing one would leave the summary without its start.
        throw new Error(`session file compaction summary ${summary.compactionId} bracket crosses end-seed event ${candidate.eventId}`)
      }
    }
    for (const shadowedId of summary.shadowedIds) {
      if (entryEventIds.has(shadowedId)) {
        throw new Error(`session file compaction summary ${summary.compactionId} lists live event ${shadowedId} as shadowed`)
      }
    }
  }
  // The per-summary checks above validate each claimed bracket in isolation;
  // replay's compaction invariant (dsh-compaction invariant.ts) is the
  // authority for the entry sequence: a compaction/start opens a transaction
  // that only its end closes, a second start while one is open is rejected,
  // and summary, checkpoint, and end events must name the open transaction.
  // The side table records successful compactions, but a migrated legacy log
  // also carries transactions it does not list — a failed start → end{error}
  // transaction has no summary by design, and a successful migrated
  // transaction keeps its markers without a side-table record — so unclaimed
  // markers are validated with the same transaction state machine instead of
  // being rejected by ownership. A marker id claimed by two summaries is
  // rejected when the map is built.
  const eventIdAtRank = (rank: number): EventId => {
    const entry = entries[rank]
    /* v8 ignore next 2 -- entries were validated above */
    if (entry === undefined) throw new Error(`session file is missing entry at rank ${rank}`)
    return entry.eventId
  }
  const invalidTransactionMessage = (eventId: EventId): string =>
    `session file compaction marker ${eventId} has no open compaction transaction`
  let openTurn: number | null = null
  let openTransaction: {
    readonly summary?: CompactionSummary
    readonly compactionId: string
    readonly turn?: number | null
    readonly sourceCommandId?: unknown
    summarized: boolean
  } | undefined
  for (let rank = 0; rank < entries.length; rank += 1) {
    const eventId = eventIdAtRank(rank)
    const owner = summaryByMarkerId.get(eventId)
    if (owner === undefined) {
      // Unclaimed events: turn boundaries and compaction markers the side
      // table does not list (a migrated failed transaction has no summary by
      // design; a successful migrated transaction keeps its markers without a
      // side-table record). They are validated with the same envelope and
      // transaction rules replay applies, so an unclaimed marker cannot
      // smuggle a shape replay would reject.
      const entry = entries[rank] as LeafEntry
      let envelope: unknown
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blobs.get(entry.blobId)))
      } catch {
        continue
      }
      const eventType = isRecord(envelope) ? envelope.type : undefined
      const eventData = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined
      if (eventType === 'turn/start') {
        // Replay's validateTurnBoundary forbids a turn boundary crossing an
        // open compaction, whether the transaction is claimed or not.
        if (openTransaction !== undefined) {
          throw new Error(`session file turn boundary ${eventId} crosses an open compaction transaction`)
        }
        openTurn = eventData?.turn as number | null ?? null
        continue
      }
      if (eventType === 'turn/end') {
        if (openTransaction !== undefined) {
          throw new Error(`session file turn boundary ${eventId} crosses an open compaction transaction`)
        }
        openTurn = null
        continue
      }
      if (eventType === 'compaction/start') {
        if (openTransaction !== undefined) {
          throw new Error('session file compaction summaries must not nest or interleave')
        }
        if (!isRecord(envelope) || invalidMarkerEnvelope(envelope)) {
          throw new Error(`session file compaction marker ${eventId} has an invalid envelope`)
        }
        if (carriesSurfaceMetadata(envelope)) {
          throw new Error(`session file compaction marker ${eventId} must not carry surface metadata`)
        }
        const compactionId = isRecord(eventData) && typeof eventData.compactionId === 'string' && eventData.compactionId.length > 0
          ? eventData.compactionId
          : ''
        if (compactionId === '') throw new Error(invalidTransactionMessage(eventId))
        const turn = eventData?.turn as number | null | undefined
        if (turn !== null && typeof turn !== 'number') throw new Error(invalidTransactionMessage(eventId))
        if (turn === null ? openTurn !== null : openTurn !== turn) {
          throw new Error(`session file compaction marker ${eventId} names a turn that is not open`)
        }
        const sourceCommandId = eventData?.sourceCommandId
        if (sourceCommandId !== undefined && (typeof sourceCommandId !== 'string' || sourceCommandId.length === 0)) {
          throw new Error(`session file compaction marker ${eventId} must carry a non-empty string sourceCommandId`)
        }
        openTransaction = { compactionId, turn, sourceCommandId, summarized: false }
      } else if (eventType === 'compaction/summary') {
        if (openTransaction === undefined || !isRecord(eventData) || eventData.compactionId !== openTransaction.compactionId) {
          throw new Error(invalidTransactionMessage(eventId))
        }
        if (!isRecord(envelope) || invalidMarkerEnvelope(envelope)) {
          throw new Error(`session file compaction marker ${eventId} has an invalid envelope`)
        }
        if (carriesSurfaceMetadata(envelope)) {
          throw new Error(`session file compaction marker ${eventId} must not carry surface metadata`)
        }
        if (eventData.sourceCommandId !== openTransaction.sourceCommandId) {
          throw new Error(`session file compaction marker ${eventId} must carry a consistent sourceCommandId`)
        }
        if (openTransaction.summarized) {
          throw new Error(`session file compaction marker ${eventId} repeats a summary within one transaction`)
        }
        // The summary payload must satisfy replay's summary checks even
        // without a side-table record to compare against.
        const summarySeqs = eventData.shadowedSeqs
        const summaryRange = eventData.shadowedRange
        const summaryTokenCount = eventData.shadowedTokenCount
        if (!Array.isArray(summarySeqs) || summarySeqs.length === 0
          || !summarySeqs.every((seq: unknown) => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
          || !isRecord(summaryRange)
          || typeof summaryRange.start !== 'number' || typeof summaryRange.end !== 'number'
          || summarySeqs[0] !== summaryRange.start || summarySeqs.at(-1) !== summaryRange.end
          || typeof summaryTokenCount !== 'number' || !Number.isSafeInteger(summaryTokenCount) || summaryTokenCount < 0
          || typeof eventData.provider !== 'string' || eventData.provider.length === 0
          || typeof eventData.model !== 'string' || eventData.model.length === 0) {
          throw new Error(`session file compaction marker ${eventId} has an invalid summary payload`)
        }
        openTransaction.summarized = true
      } else if (eventType === 'compaction/end') {
        if (openTransaction === undefined || !isRecord(eventData) || eventData.compactionId !== openTransaction.compactionId) {
          throw new Error(invalidTransactionMessage(eventId))
        }
        if (!isRecord(envelope) || invalidMarkerEnvelope(envelope)) {
          throw new Error(`session file compaction marker ${eventId} has an invalid envelope`)
        }
        /* jscpd:ignore-start -- log-only and sourceCommandId checks shared with the summary branch */
        if (carriesSurfaceMetadata(envelope)) {
          throw new Error(`session file compaction marker ${eventId} must not carry surface metadata`)
        }
        if (eventData.sourceCommandId !== openTransaction.sourceCommandId) {
          throw new Error(`session file compaction marker ${eventId} must carry a consistent sourceCommandId`)
        }
        /* jscpd:ignore-end */
        if (eventData.turn !== openTransaction.turn) {
          throw new Error(`session file compaction marker ${eventId} must carry the transaction's turn`)
        }
        if (eventData.error === undefined && !openTransaction.summarized) {
          throw new Error(`session file compaction marker ${eventId} ends a transaction without a summary`)
        }
        openTransaction = undefined
      } else if (eventType === 'session/end-seed') {
        // An end-seed makes a still-open inherited transaction stale, as
        // dsh-compaction's invariant does; it closes the transaction.
        openTransaction = undefined
      } else if (eventType === 'user/message' && isRecord(envelope)
        && isRecord(envelope.surfaceOp) && envelope.surfaceOp.op === 'replace'
        && isRecord(eventData) && isRecord(eventData.source)
        && isCompactCheckpointSource(eventData.source as unknown as never)) {
        // An unclaimed checkpoint requires the open transaction it names and
        // must share the transaction's initiating command, as replay's
        // validateCheckpoint requires.
        const checkpointCompactionId = eventData.source.compactionId
        if (openTransaction === undefined || typeof checkpointCompactionId !== 'string'
          || checkpointCompactionId !== openTransaction.compactionId) {
          throw new Error(invalidTransactionMessage(eventId))
        }
        if (eventData.source.sourceCommandId !== openTransaction.sourceCommandId) {
          throw new Error(`session file compaction marker ${eventId} must carry a consistent sourceCommandId`)
        }
      }
      continue
    }
    if (eventId === owner.markerEventIds.startEventId) {
      if (openTransaction !== undefined) {
        throw new Error('session file compaction summaries must not nest or interleave')
      }
      // The side table's sourceCommandId mirrors the start marker (checked per
      // summary above), so the claimed transaction carries it for the
      // checkpoint's command-ownership comparison like an unclaimed one.
      openTransaction = {
        summary: owner,
        compactionId: owner.compactionId,
        ...(owner.sourceCommandId === undefined ? {} : { sourceCommandId: owner.sourceCommandId }),
        summarized: false,
      }
    } else if (eventId === owner.markerEventIds.summaryEventId) {
      /* v8 ignore next 2 -- per-summary order pins the summary after its start; the start-nesting check rejects other opens */
      if (openTransaction?.summary !== owner) {
        throw new Error('session file compaction summaries must not nest or interleave')
      }
      if (openTransaction.summarized) {
        throw new Error(`session file compaction marker ${eventId} repeats a summary within one transaction`)
      }
      openTransaction.summarized = true
    } else if (eventId === owner.checkpointEventId) {
      /* v8 ignore next 2 -- per-summary order pins the checkpoint inside its bracket; the start-nesting check rejects other opens */
      if (openTransaction?.summary !== owner) {
        throw new Error('session file compaction summaries must not nest or interleave')
      }
    } else {
      // summaryByMarkerId holds only checkpoint/start/summary/end ids, so the
      // remaining claimed marker is the end.
      /* v8 ignore next 2 -- per-summary order pins the end after its checkpoint; the start-nesting check rejects other opens */
      if (openTransaction?.summary !== owner) {
        throw new Error('session file compaction summaries must not nest or interleave')
      }
      openTransaction = undefined
    }
  }
  for (const reference of references) {
    if (!entryEventIds.has(reference.fromEventId)) {
      throw new Error(`session file reference ${reference.fromEventId} sources a missing event`)
    }
    for (const toEventId of reference.toEventIds) {
      if (!entryEventIds.has(toEventId)) {
        throw new Error(`session file reference ${reference.fromEventId} targets missing event ${toEventId}`)
      }
    }
  }
  return { session, entries, blobs, references, compacted }
}

/**
 * Rebuild an in-memory tree from a session file payload.
 * @param file - the session file whose entries become the tree.
 * @returns the rebuilt tree.
 */
export function treeFromFile(file: SessionFile): SessionTree {
  return SessionTree.fromEntries(file.entries)
}

/**
 * Write a session file to disk atomically inside a checksummed snapshot,
 * with the parent directory fsynced on POSIX so the replacement is
 * crash-durable.
 * @param path - the destination path.
 * @param file - the session file to write.
 * @returns a promise that settles once the replacement is crash-durable.
 */
export async function writeSessionFile(path: string, file: SessionFile): Promise<void> {
  const data = serializeSessionFile(file)
  // Durable/file boundary: reject a payload whose cross-references do not
  // hold (missing blob, dangling seed boundary, dangling checkpoint) before
  // it can replace the last readable version on disk.
  deserializeSessionFile(data)
  await writeSnapshotFile(path, data)
}

/**
 * Read a session file from disk, verifying the snapshot checksum.
 * @param path - the file path to read.
 * @returns the validated session file.
 */
export async function readSessionFile(path: string): Promise<SessionFile> {
  return deserializeSessionFile(await readSnapshotFile(path))
}

/**
 * Export a session file as a self-contained byte archive.
 * This is the export/import entry point of the format; it currently shares the
 * serialized payload with `serializeSessionFile` and will diverge once export
 * gains transport concerns (compression, envelopes).
 * @param file - the session file to export.
 * @returns the archive bytes.
 */
export function exportSessionFile(file: SessionFile): Uint8Array {
  const data = serializeSessionFile(file)
  // A self-contained archive must be re-importable: reject payloads whose
  // cross-references do not hold before returning the bytes.
  deserializeSessionFile(data)
  return data
}

/**
 * Import a session file from a self-contained byte archive.
 * @param data - the archive bytes.
 * @returns the validated session file.
 */
export function importSessionFile(data: Uint8Array): SessionFile {
  return deserializeSessionFile(data)
}

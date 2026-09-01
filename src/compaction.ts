/**
 * Prototype physical compaction transaction for the session format.
 * This combines explicit surface-event removal, reference redirection,
 * replacement events, and a caller-supplied revision token in one logical
 * transaction.
 * @module @deepseek-ai/dsh-session-format/compaction
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { isSurfaceEligibleType } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionTree, type LeafEntry } from './btree.ts'
import { invalidTokenUsage, isContentBlock } from './file.ts'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionFile } from './file.ts'
import type {
  BlobId,
  CompactionId,
  CompactionSummary,
  EventId,
  ReferenceRecord,
  SessionRevision,
  StoredSessionRecord,
} from './index.ts'

/** Inputs needed to perform one physical compaction. */
export interface CompactionInput {
  /** Surface events physically removed by this compaction; must all be present. */
  readonly shadowedIds: readonly EventId[]
  readonly checkpointEventId: EventId
  /** Blob holding the checkpoint payload; must already exist in the file's blob map. */
  readonly checkpointBlobId: BlobId
  readonly compactionId: CompactionId
  readonly startEventId: EventId
  readonly summaryEventId: EventId
  readonly endEventId: EventId
  /** Blob for the start marker; must already exist in the file's blob map. */
  readonly startBlobId: BlobId
  /** Blob for the summary marker; must already exist in the file's blob map. */
  readonly summaryBlobId: BlobId
  /** Blob for the end marker; must already exist in the file's blob map. */
  readonly endBlobId: BlobId
  /** Opaque revision token the next session record carries; the caller owns revision semantics. */
  readonly nextRevision: SessionRevision
  /**
   * The next EventId counter value the compacted record carries. The caller
   * allocates the four replacement EventIds from the current counter, so this
   * must sit above every id it minted for this transaction.
   */
  readonly nextEventCounter: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The fixed event type an audit marker blob must carry, when it has one.
 * Per-field checks keep duplicates of the same blob id unambiguous.
 * @param blobId - the replacement blob identity.
 * @param input - the compaction inputs naming the four replacement blobs.
 * @returns the required event type, or undefined for the caller-chosen checkpoint.
 */
function expectedEnvelopeType(blobId: BlobId, input: CompactionInput): string | undefined {
  if (blobId === input.startBlobId) return 'compaction/start'
  if (blobId === input.summaryBlobId) return 'compaction/summary'
  if (blobId === input.endBlobId) return 'compaction/end'
  return undefined
}

/**
 * Validate one replacement event blob's `{ type, time, data }` envelope.
 * The audit markers (start/summary/end) must carry their fixed type and the
 * transaction's compactionId in `data`; the checkpoint envelope is checked for
 * shape only, because its type is the caller's summarization event.
 * @param blobId - the blob identity being validated.
 * @param bytes - the blob payload.
 * @param expectedType - the exact event type the blob must carry, when fixed.
 * @param expectedCompactionId - the compactionId the marker data must carry, when fixed.
 */
function validateEventEnvelope(
  blobId: BlobId,
  bytes: Uint8Array,
  expectedType: string | undefined,
  expectedCompactionId: CompactionId | undefined,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`replacement blob ${blobId} must be a JSON event envelope`)
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string'
    || typeof parsed.time !== 'number' || !Number.isSafeInteger(parsed.time) || parsed.time < 0
    || !('data' in parsed)
    || (parsed.ignorable !== undefined && parsed.ignorable !== true)
    || Object.keys(parsed).some(key => key !== 'type' && key !== 'time' && key !== 'data'
      && key !== 'surfaceOp' && key !== 'sourceEventSeqs' && key !== 'ignorable')) {
    throw new Error(`replacement blob ${blobId} must be a { type, time, data } event envelope`)
  }
  if (expectedType !== undefined && parsed.type !== expectedType) {
    throw new Error(`replacement blob ${blobId} must be a ${expectedType} event`)
  }
  const data = parsed.data
  if (expectedCompactionId !== undefined && (!isRecord(data) || data.compactionId !== expectedCompactionId)) {
    throw new Error(`replacement blob ${blobId} must belong to compaction ${expectedCompactionId}`)
  }
  if (expectedType === 'compaction/start' || expectedType === 'compaction/end') {
    // The bracket markers are log-only records, not surface events: a
    // surfaceOp or sourceEventSeqs on them would be rejected by the surface
    // validation at restore, so a caller-supplied blob carrying either is
    // rejected at the transaction boundary instead.
    if (parsed.surfaceOp !== undefined || parsed.sourceEventSeqs !== undefined) {
      throw new Error(`replacement blob ${blobId} must not carry surface metadata`)
    }
    if (!isRecord(data) || (data.turn !== null && typeof data.turn !== 'number')) {
      throw new Error(`replacement blob ${blobId} must carry a numeric or null turn`)
    }
    if (expectedType === 'compaction/end' && data.error !== undefined) {
      throw new Error(`replacement blob ${blobId} records a failed compaction`)
    }
  }
  if (expectedType === 'compaction/summary') {
    // Same log-only rule as the bracket markers.
    if (parsed.surfaceOp !== undefined || parsed.sourceEventSeqs !== undefined) {
      throw new Error(`replacement blob ${blobId} must not carry surface metadata`)
    }
    if (!isRecord(data) || !isRecord(data.shadowedRange)) {
      throw new Error(`replacement blob ${blobId} must carry a numeric shadowedRange`)
    }
    const seqRange = data.shadowedRange
    if (typeof seqRange.start !== 'number' || typeof seqRange.end !== 'number'
      || !Number.isSafeInteger(seqRange.start) || !Number.isSafeInteger(seqRange.end)
      || seqRange.start < 0 || seqRange.end < 0) {
      throw new Error(`replacement blob ${blobId} must carry a non-negative safe integer shadowedRange`)
    }
    const shadowedSeqs = data.shadowedSeqs
    /* jscpd:ignore-start -- seq-array validation shared with the file deserializer; each side reports its own boundary's message. */
    if (!Array.isArray(shadowedSeqs)
      || shadowedSeqs.length === 0
      || !shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      || shadowedSeqs[0] !== seqRange.start
      || shadowedSeqs[shadowedSeqs.length - 1] !== seqRange.end) {
      throw new Error(`replacement blob ${blobId} must carry a shadowedSeqs array spanning its shadowedRange`)
    }
    /* jscpd:ignore-end */
  }
}

/**
 * Extract the durable summary fields from the caller-provided
 * `compaction/summary` event blob, so the summary record mirrors the event
 * payload instead of duplicating it.
 * @param bytes - the summary blob payload.
 * @returns the summary fields carried by the event data.
 */
function extractSummaryFields(bytes: Uint8Array | undefined): {
  readonly summary: readonly ContentBlock[]
  readonly shadowedSeqRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  readonly sourceCommandId?: string
  readonly maxTokens?: number
  readonly usage?: Record<string, unknown>
  readonly rawOutput?: readonly ContentBlock[]
  readonly llmStreamCall?: boolean
} {
  /* v8 ignore next 3 -- the replacement-blob presence loop above already rejected a missing summary blob */
  if (bytes === undefined) {
    throw new Error('compaction/summary blob must be present in the file')
  }
  // The envelope check above already parsed the same bytes successfully and
  // required `data` to be an object for the marker, so this parse cannot throw.
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const envelope = parsed as Record<string, unknown>
  const data = envelope.data as Record<string, unknown>
  const {
    summary,
    shadowedRange,
    shadowedSeqs,
    shadowedTokenCount,
    provider,
    model,
    sourceCommandId,
    maxTokens,
    usage,
    rawOutput,
    llmStreamCall,
  } = data
  if (!Array.isArray(summary) || !summary.every(isContentBlock) || !isJsonValue(summary)) {
    throw new Error('compaction/summary blob data.summary must be a content block array')
  }
  if (typeof shadowedTokenCount !== 'number'
    || !Number.isSafeInteger(shadowedTokenCount)
    || shadowedTokenCount < 0) {
    throw new Error('compaction/summary blob data.shadowedTokenCount must be a non-negative safe integer')
  }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('compaction/summary blob data.provider and data.model must be strings')
  }
  // The marker-consistency loop above already validated sourceCommandId as a
  // non-empty string; the cast narrows the unknown field for the summary type.
  const typedSourceCommandId = sourceCommandId === undefined ? undefined : sourceCommandId as string
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 0)) {
    throw new Error('compaction/summary blob data.maxTokens must be a non-negative safe integer')
  }
  if (usage !== undefined
    && (!isRecord(usage) || invalidTokenUsage(usage))) {
    throw new Error('compaction/summary blob data.usage must be a token usage record')
  }
  if (llmStreamCall !== undefined && llmStreamCall !== true) {
    throw new Error('compaction/summary blob data.llmStreamCall must be true or absent')
  }
  if (rawOutput !== undefined
    && (!Array.isArray(rawOutput) || !rawOutput.every(isContentBlock) || !isJsonValue(rawOutput))) {
    throw new Error('compaction/summary blob data.rawOutput must be a content block array')
  }
  if (llmStreamCall === true && rawOutput === undefined) {
    throw new Error('compaction/summary blob data.rawOutput is required when llmStreamCall is true')
  }
  return {
    summary: summary as unknown as readonly ContentBlock[],
    shadowedSeqRange: shadowedRange as { readonly start: number; readonly end: number },
    shadowedSeqs: shadowedSeqs as readonly number[],
    shadowedTokenCount,
    provider,
    model,
    ...(typedSourceCommandId === undefined ? {} : { sourceCommandId: typedSourceCommandId }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(usage === undefined ? {} : { usage }),
    ...(rawOutput === undefined ? {} : { rawOutput: rawOutput as unknown as readonly ContentBlock[] }),
    ...(llmStreamCall === undefined ? {} : { llmStreamCall }),
  }
}

/** Parse a blob as a record envelope, or undefined when it is not JSON. */
function tryParseEnvelope(bytes: Uint8Array | undefined): Record<string, unknown> | undefined {
  if (bytes === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Run one physical compaction and return the new session file.
 * Exactly the explicit `shadowedIds` surface events are removed; log-only
 * events between them survive. The four replacement event blobs are supplied
 * by the caller and must already exist in the file's blob map, encoded as full
 * event blobs in the package's event format so every replacement entry replays
 * like any other event. References sourced by a shadowed event are dropped;
 * references targeting a shadowed event are redirected to the checkpoint
 * event; blobs referenced only by shadowed events are removed from the result;
 * a seed boundary inside the shadowed set is redirected to the checkpoint
 * event. An earlier transaction's bracket (start/summary/checkpoint/end
 * markers) is indivisible: shadowing any part of it requires shadowing the
 * whole marker group. The prototype does not maintain page roots: `rootPage`
 * stays as-is and `backups` is not extended — page persistence, the CAS
 * commit, and rolling backups belong to the persistence layer.
 * @param file - the current session file.
 * @param input - the shadowed surface events and replacement event/blob ids.
 * @returns the compacted session file.
 */
export function performCompaction(file: SessionFile, input: CompactionInput): SessionFile {
  const oldEntries = file.entries
  // One index serves every existence, blob, and rank lookup below; a
  // compaction shadowing roughly half the session must stay linear instead of
  // degrading to O(n·k) repeated scans.
  const entryByEventId = new Map(oldEntries.map(entry => [entry.eventId, entry]))
  const entryRankById = new Map(oldEntries.map((entry, index) => [entry.eventId, index]))

  if (typeof input.compactionId !== 'string' || input.compactionId.length === 0) {
    throw new Error('compaction input compactionId must be a non-empty string')
  }
  const shadowedIds = [...input.shadowedIds]
  if (shadowedIds.length === 0) {
    throw new Error('compaction shadowedIds must not be empty')
  }
  const replacementEventIds = [input.startEventId, input.summaryEventId, input.checkpointEventId, input.endEventId]
  const sessionPrefix = `evt_${file.session.sessionId}_`
  for (const id of replacementEventIds) {
    if (!id.startsWith(sessionPrefix) || !/^\d+$/.test(id.slice(sessionPrefix.length))) {
      throw new Error(`replacement EventId ${id} must carry the session prefix and a numeric suffix`)
    }
  }
  const replacementMax = replacementEventIds.reduce((max, id) => {
    // The prefix check above guarantees a numeric suffix.
    const value = Number(id.slice(sessionPrefix.length))
    return value > max ? value : max
  }, -1)
  if (typeof input.nextEventCounter !== 'number'
    || !Number.isSafeInteger(input.nextEventCounter)
    || input.nextEventCounter < file.session.nextEventCounter
    || input.nextEventCounter <= replacementMax) {
    throw new Error('compaction input nextEventCounter must exceed the replacement EventIds and the session counter')
  }
  const seenShadowed = new Set<EventId>()
  for (const id of shadowedIds) {
    if (seenShadowed.has(id)) {
      throw new Error('compaction shadowedIds must not contain duplicates')
    }
    if (!entryByEventId.has(id)) {
      throw new Error('compaction shadowedIds must name present EventIds')
    }
    seenShadowed.add(id)
  }
  const shadowed = new Set<EventId>(shadowedIds)

  // The shadowed events are surface events being replaced: each must carry a
  // surfaceOp marker, so a log-only event cannot be silently deleted. Events
  // that are markers of an earlier transaction are exempt — retiring a whole
  // transaction bracket necessarily removes its log-only markers. A migrated
  // file also carries transactions with no side-table record; their brackets
  // are found by scanning the entry stream and treated the same way, so a
  // whole unclaimed bracket can be retired and a partial one cannot.
  const unclaimedBrackets: Array<readonly EventId[]> = []
  {
    let openBracket: EventId[] | undefined
    for (const entry of oldEntries) {
      let envelope: unknown
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.blobs.get(entry.blobId)))
      } catch {
        continue
      }
      const eventType = isRecord(envelope) ? envelope.type : undefined
      const eventData = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined
      const isCheckpoint = eventType === 'user/message' && isRecord(envelope)
        && isRecord(envelope.surfaceOp) && envelope.surfaceOp.op === 'replace'
        && isRecord(eventData) && isRecord(eventData.source)
        && isCompactCheckpointSource(eventData.source as unknown as never)
      if (eventType === 'compaction/start') {
        openBracket = [entry.eventId]
      } else if (openBracket !== undefined
        && (eventType === 'compaction/summary' || eventType === 'compaction/end' || isCheckpoint)) {
        openBracket.push(entry.eventId)
        if (eventType === 'compaction/end') {
          unclaimedBrackets.push(openBracket)
          openBracket = undefined
        }
      }
    }
  }
  const earlierMarkerIds = new Set<EventId>()
  for (const summary of file.compacted) {
    earlierMarkerIds.add(summary.checkpointEventId)
    earlierMarkerIds.add(summary.markerEventIds.startEventId)
    earlierMarkerIds.add(summary.markerEventIds.summaryEventId)
    earlierMarkerIds.add(summary.markerEventIds.endEventId)
  }
  for (const bracket of unclaimedBrackets) {
    for (const id of bracket) earlierMarkerIds.add(id)
  }
  for (const id of shadowedIds) {
    if (earlierMarkerIds.has(id)) continue
    // shadowedIds was validated present above, so the entry and its blob exist.
    const entry = entryByEventId.get(id) as LeafEntry
    const bytes = file.blobs.get(entry.blobId)
    let envelope: unknown
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      envelope = undefined
    }
    if (!isRecord(envelope) || !('surfaceOp' in envelope) || !isSurfaceEligibleType(envelope.type as string)) {
      throw new Error(`shadowed event ${id} must be a surface event with a surfaceOp marker`)
    }
  }


  // Transaction brackets are indivisible: shadowing any of an earlier
  // transaction's markers (start/summary/checkpoint/end) requires shadowing
  // the whole marker group, otherwise the survivors form an unclosed or
  // duplicated transaction stream.
  for (const summary of file.compacted) {
    const markerIds = [
      summary.checkpointEventId,
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]
    const shadowedMarkers = markerIds.filter(id => shadowed.has(id))
    if (shadowedMarkers.length > 0 && shadowedMarkers.length < markerIds.length) {
      throw new Error('compaction range must not cut an earlier transaction in half')
    }
  }
  for (const bracket of unclaimedBrackets) {
    const shadowedMarkers = bracket.filter(id => shadowed.has(id))
    if (shadowedMarkers.length > 0 && shadowedMarkers.length < bracket.length) {
      throw new Error('compaction range must not cut an earlier transaction in half')
    }
  }

  const retiredIds = new Set<EventId>(oldEntries.map(entry => entry.eventId))
  for (const summary of file.compacted) {
    for (const id of summary.shadowedIds) retiredIds.add(id)
  }
  const replacementIds = [input.startEventId, input.summaryEventId, input.checkpointEventId, input.endEventId]
  const seenReplacement = new Set<EventId>()
  for (const id of replacementIds) {
    // EventIds are never reused: a replacement must not collide with a live
    // event or with an event retired by an earlier compaction.
    if (retiredIds.has(id) || seenReplacement.has(id)) {
      throw new Error('replacement EventIds must be unique and not collide with existing or retired events')
    }
    seenReplacement.add(id)
  }
  // EventId counters never go backwards: every replacement id must sit at or
  // above the session's committed high-water mark, or the transaction could
  // reuse an identity hidden by backup rotation or an earlier compaction.
  // Checked after the collision scan so a direct collision reports its more
  // specific error.
  const replacementMin = replacementIds.reduce((min, id) => {
    const value = Number(id.slice(sessionPrefix.length))
    return value < min ? value : min
  }, Number.POSITIVE_INFINITY)
  if (replacementMin < file.session.nextEventCounter) {
    throw new Error('compaction input nextEventCounter must exceed the replacement EventIds and the session counter')
  }

  const replacementBlobIds = [input.startBlobId, input.summaryBlobId, input.checkpointBlobId, input.endBlobId]
  if (new Set(replacementBlobIds).size !== replacementBlobIds.length) {
    throw new Error('replacement BlobIds must be pairwise distinct and already present in the file')
  }
  for (const id of replacementBlobIds) {
    const bytes = file.blobs.get(id)
    if (bytes === undefined) {
      throw new Error('replacement BlobIds must be pairwise distinct and already present in the file')
    }
    if (oldEntries.some(entry => entry.blobId === id)) {
      throw new Error('replacement BlobIds must not be referenced by existing events')
    }
    validateEventEnvelope(
      id,
      bytes,
      expectedEnvelopeType(id, input),
      expectedEnvelopeType(id, input) === undefined ? undefined : input.compactionId,
    )
    if (id === input.checkpointBlobId) {
      // validateEventEnvelope above guarantees the blob parses as a record.
      // The checkpoint is a surface user message in the package's event
      // format: `surfaceOp` sits at the envelope top level, and the message
      // object (with its `source` provenance) lives inside `data`, exactly as
      // createUserMessage frames it and migrateLegacySession encodes it. The
      // type is pinned to `user/message` because the compaction invariant only
      // recognizes that surface type as a checkpoint.
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      const surfaceOp = envelope.surfaceOp
      const data = envelope.data
      if (envelope.type !== 'user/message'
        || !isRecord(data)
        || typeof data.id !== 'string' || data.id === ''
        || data.role !== 'user'
        || !Array.isArray(data.content)
        || !isRecord(data.source)
        || !isCompactCheckpointSource(data.source as unknown as never)
        || data.source.compactionId !== input.compactionId
        || !isRecord(surfaceOp)
        || surfaceOp.op !== 'replace'
        // core isReplaceOp requires exactly { op, start, end }.
        /* jscpd:ignore-start -- replace-surfaceOp check shared with file.ts */
        || Object.keys(surfaceOp).length !== 3
        || typeof surfaceOp.start !== 'number'
        || !Number.isSafeInteger(surfaceOp.start)
        || surfaceOp.start < 0
        || typeof surfaceOp.end !== 'number'
        || !Number.isSafeInteger(surfaceOp.end)
        || surfaceOp.end < 0) {
        /* jscpd:ignore-end */
        throw new Error('checkpoint blob must be a surface event carrying a replace surfaceOp with a valid range')
      }
      // The checkpoint's replace range must describe the same span the summary
      // records: both come from one start/end pair in the real compaction
      // path, so a mismatch means the caller passed internally inconsistent
      // inputs. It must also carry the provenance foldSurface's
      // assertProvenance requires: the source event seqs of every shadowed
      // surface node, so the produced file can actually be restored.
      const summaryBytes = file.blobs.get(input.summaryBlobId) as Uint8Array
      const summaryParsed = JSON.parse(new TextDecoder().decode(summaryBytes)) as Record<string, unknown>
      const summaryData = summaryParsed.data as Record<string, unknown>
      const summaryRange = summaryData.shadowedRange as { readonly start?: unknown; readonly end?: unknown }
      const summarySeqs = summaryData.shadowedSeqs
      const envelopeSourceSeqs = envelope.sourceEventSeqs
      if (summaryRange.start !== surfaceOp.start || summaryRange.end !== surfaceOp.end) {
        throw new Error('checkpoint replace range must match the summary shadowedRange')
      }
      const envelopeSeqSet = Array.isArray(envelopeSourceSeqs) ? new Set(envelopeSourceSeqs as number[]) : undefined
      if (!Array.isArray(envelopeSourceSeqs)
        || envelopeSourceSeqs.length === 0
        || !envelopeSourceSeqs.every((seq: unknown) => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
        || envelopeSeqSet === undefined
        || envelopeSeqSet.size !== envelopeSourceSeqs.length
        || !Array.isArray(summarySeqs)
        || !summarySeqs.every((seq: unknown) => envelopeSeqSet.has(seq as number))) {
        throw new Error('checkpoint blob must cite every shadowed surface node in sourceEventSeqs')
      }
    }
    if (id === input.summaryBlobId) {
      // The summary event's seq facts must describe exactly the surface
      // events being replaced; log-only markers of an earlier transaction
      // that are retired as a bracket are not surface nodes.
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      const summaryData = envelope.data as Record<string, unknown>
      const seqs = summaryData.shadowedSeqs
      const surfaceShadowed = shadowedIds.filter((eventId) => {
        // Shadowed ids were validated present with parseable blobs above.
        const entry = entryByEventId.get(eventId) as LeafEntry
        const entryEnvelope = JSON.parse(new TextDecoder().decode(file.blobs.get(entry.blobId))) as Record<string, unknown>
        return 'surfaceOp' in entryEnvelope
      })
      if (!Array.isArray(seqs) || seqs.length !== surfaceShadowed.length) {
        throw new Error('summary blob shadowedSeqs must describe the same number of surface events as shadowedIds')
      }
    }
  }

  // The marker group shares the transaction identity: start/end turns must
  // match and sourceCommandId must be consistent across start/summary/end and
  // the checkpoint provenance (dsh-compaction's validateSourceCommandId
  // requires the checkpoint to share the start's sourceCommandId).
  const markerFacts = new Map<BlobId, { readonly turn?: unknown; readonly sourceCommandId?: unknown }>()
  for (const markerBlobId of [input.startBlobId, input.summaryBlobId, input.endBlobId]) {
    // The replacement loop above validated presence and the envelope data.
    const markerBytes = file.blobs.get(markerBlobId) as Uint8Array
    const markerParsed = JSON.parse(new TextDecoder().decode(markerBytes)) as Record<string, unknown>
    const markerData = markerParsed.data as Record<string, unknown>
    markerFacts.set(markerBlobId, {
      turn: markerData.turn,
      sourceCommandId: markerData.sourceCommandId,
    })
  }
  {
    // The checkpoint's source carries the initiating command id; fold it into
    // the consistency comparison alongside the start/summary/end markers.
    const checkpointBytes = file.blobs.get(input.checkpointBlobId) as Uint8Array
    const checkpointParsed = JSON.parse(new TextDecoder().decode(checkpointBytes)) as Record<string, unknown>
    const checkpointData = checkpointParsed.data as Record<string, unknown>
    const checkpointSource = checkpointData.source as Record<string, unknown>
    markerFacts.set(input.checkpointBlobId, {
      sourceCommandId: checkpointSource.sourceCommandId,
    })
  }
  const firstTurn = markerFacts.get(input.startBlobId)?.turn
  const firstCommand = markerFacts.get(input.startBlobId)?.sourceCommandId
  for (const [blobId, facts] of markerFacts) {
    if (blobId === input.endBlobId && facts.turn !== firstTurn) {
      throw new Error('compaction/start and compaction/end markers must carry the same turn')
    }
    // A present sourceCommandId must be a non-empty string; the empty string
    // would pass every equality check but fails dsh-compaction's
    // validateSourceCommandId at replay time.
    if (facts.sourceCommandId !== undefined
      && (typeof facts.sourceCommandId !== 'string' || facts.sourceCommandId.length === 0)) {
      throw new Error('compaction marker blobs must carry a non-empty string sourceCommandId')
    }
    // Every marker (start/summary/end and the checkpoint) must agree with the
    // start marker's sourceCommandId exactly: dsh-compaction's
    // validateSourceCommandId requires them equal (both absent for automatic
    // compactions, or both the same id for manual ones), so a marker that
    // omits it while the start carries one — or vice versa — is rejected here
    // instead of failing at replay.
    if (facts.sourceCommandId !== firstCommand) {
      throw new Error('compaction marker blobs must carry a consistent sourceCommandId')
    }
  }

  // Remove exactly the explicit shadowed surface events; log-only events
  // between them survive (`removeEntries` renumbers the survivors densely).
  // Derive the insertion point and range endpoints from tree order: the
  // shadowed set is unordered, so the earliest and latest shadowed entries in
  // the entry sequence define them. The recorded shadowedRange must describe
  // the surface span, so its endpoints come from the shadowed SURFACE events
  // only — when a whole earlier transaction bracket is retired, the log-only
  // start/end markers are shadowed too and must not become range endpoints.
  // Every shadowed id was validated present with a parseable blob above
  // (non-marker surface events) or comes from a prior compaction (markers),
  // so the parse cannot fail; log-only markers are excluded from the range.
  const surfaceShadowedIds = shadowedIds.filter((id) => {
    const entry = entryByEventId.get(id) as LeafEntry
    const candidateEnvelope: unknown = JSON.parse(new TextDecoder().decode(file.blobs.get(entry.blobId)))
    return isRecord(candidateEnvelope) && 'surfaceOp' in candidateEnvelope
  })
  /* v8 ignore next 3 -- unreachable: every complete retired bracket includes its surface checkpoint; a partial group is rejected above */
  if (surfaceShadowedIds.length === 0) {
    // Retiring only log-only markers leaves no surface span to replace; the
    // range endpoints below are derived from the shadowed SURFACE events, so
    // an all-marker input must be rejected here instead of crashing later.
    throw new Error('compaction shadowedIds must include at least one surface event')
  }
  const surfaceRanks = surfaceShadowedIds.map(id => entryRankById.get(id) as number)
  // Reduce instead of Math.min/Math.max spread: a compaction shadowing a very
  // large surface would exceed the engine's argument-count limit otherwise.
  // surfaceShadowedIds was validated non-empty above, so the reduces seed
  // from the first rank and both resolve.
  const firstShadowedRank = surfaceRanks.reduce((min, rank) => rank < min ? rank : min)
  const lastShadowedRank = surfaceRanks.reduce((max, rank) => rank > max ? rank : max)
  const firstShadowedEntry = oldEntries[firstShadowedRank] as LeafEntry
  const lastShadowedEntry = oldEntries[lastShadowedRank] as LeafEntry
  const firstShadowedId = firstShadowedEntry.eventId
  const lastShadowedId = lastShadowedEntry.eventId

  // The marker group must sit inside a legal turn: when the shadowed range is
  // enclosed by turn/start..turn/end pairs, the new markers must belong to the
  // turn open at that position. dsh-compaction's replay uses a single cursor:
  // applyTurnBoundary sets trace.openTurn to the last turn/start's turn and
  // clears it to null on ANY turn/end, and validateOwner requires a numeric
  // owner to equal that cursor and a null owner to find no open turn. The
  // cursor model rejects a marker naming an outer turn while an inner turn is
  // open, and a marker after an inner turn/end has cleared the cursor to null.
  const startParsed = tryParseEnvelope(file.blobs.get(input.startBlobId))
  // The replacement loop validated the start blob parses as a record.
  const startTurn = ((startParsed as Record<string, unknown>).data as Record<string, unknown>).turn
  // The single replay cursor: the last turn/start's turn, or null after any
  // turn/end (matching applyTurnBoundary, including an orphaned turn/end).
  let openTurn: number | null = null
  for (let index = 0; index <= firstShadowedRank; index += 1) {
    const candidate = oldEntries[index] as LeafEntry
    const parsed = tryParseEnvelope(file.blobs.get(candidate.blobId))
    const eventType = parsed?.type
    const eventData = isRecord(parsed?.data) ? parsed.data : undefined
    if (eventType === 'turn/start') {
      openTurn = eventData?.turn as number | null ?? null
    } else if (eventType === 'turn/end') {
      openTurn = null
    }
    if (index === firstShadowedRank) {
      // validateOwner compares the marker owner against the single cursor, so
      // a numeric marker turn must equal it exactly, and a null marker turn is
      // only legal when no turn is open at the range position.
      if (typeof startTurn === 'number' && openTurn !== startTurn) {
        throw new Error('compaction markers with a numeric turn must sit inside an open turn')
      }
      if (startTurn === null && openTurn !== null) {
        throw new Error('compaction markers must belong to the turn enclosing the shadowed range')
      }
    }
  }
  const beforeCount = oldEntries
    .slice(0, firstShadowedRank)
    .filter(entry => !shadowed.has(entry.eventId)).length

  // Interval completeness: every surface event between the earliest and
  // latest shadowed entries must be shadowed too, so the recorded range
  // cannot claim to cover a segment that still has live surface events.
  for (let index = firstShadowedRank; index <= lastShadowedRank; index += 1) {
    // index is within a validated shadowed range, so the entry exists.
    const candidate = oldEntries[index] as LeafEntry
    if (shadowed.has(candidate.eventId)) continue
    // Earlier transaction markers are log-only and carry no surfaceOp, so the
    // surface check below already lets them pass without an explicit exemption.
    let candidateEnvelope: unknown
    try {
      // A missing blob decodes as empty text, which fails JSON.parse below.
      candidateEnvelope = JSON.parse(new TextDecoder().decode(file.blobs.get(candidate.blobId)))
    } catch {
      candidateEnvelope = undefined
    }
    if (isRecord(candidateEnvelope) && 'surfaceOp' in candidateEnvelope) {
      throw new Error(`shadowed range must cover the live surface event ${candidate.eventId}`)
    }
  }
  const tree = SessionTree.fromEntries(file.entries)
  const survivors = tree.remove(shadowedIds).entries()
  const replacementEntries: LeafEntry[] = [
    { order: 0, eventId: input.startEventId, blobId: input.startBlobId },
    { order: 0, eventId: input.summaryEventId, blobId: input.summaryBlobId },
    { order: 0, eventId: input.checkpointEventId, blobId: input.checkpointBlobId },
    { order: 0, eventId: input.endEventId, blobId: input.endBlobId },
  ]
  const nextEntries = [
    ...survivors.slice(0, beforeCount),
    ...replacementEntries,
    ...survivors.slice(beforeCount),
  ]
  const ordered = nextEntries.map((entry, index) => ({ ...entry, order: index }))
  const nextTree = SessionTree.fromEntries(ordered)

  // Physical deletion: keep only blobs referenced by surviving entries. Old
  // blobs referenced only by shadowed events drop out of the serialized file.
  const nextBlobs = new Map<BlobId, Uint8Array>()
  for (const entry of nextTree.entries()) {
    const bytes = file.blobs.get(entry.blobId)
    if (bytes === undefined) {
      throw new Error(`event ${entry.eventId} references blob ${entry.blobId} that is not in the file`)
    }
    nextBlobs.set(entry.blobId, bytes)
  }

  const nextReferences: ReferenceRecord[] = file.references
    .filter(reference => !shadowed.has(reference.fromEventId))
    .map((reference) => {
      const redirected = reference.toEventIds.map(id => shadowed.has(id) ? input.checkpointEventId : id)
      const unique = [...new Set<EventId>(redirected)]
      return { ...reference, toEventIds: unique }
    })

  // Retired ids of summaries whose checkpoint is shadowed again stay in the
  // registry: fold them into the new summary so later compactions still
  // refuse to reuse those EventIds.
  const retiredByFiltered = file.compacted
    .filter(summary => shadowed.has(summary.checkpointEventId))
    .flatMap(summary => summary.shadowedIds)
  const summaryFields = extractSummaryFields(file.blobs.get(input.summaryBlobId))
  const summaryBase = {
    compactionId: input.compactionId,
    checkpointEventId: input.checkpointEventId,
    markerEventIds: {
      startEventId: input.startEventId,
      summaryEventId: input.summaryEventId,
      endEventId: input.endEventId,
    },
    shadowedRange: { startId: firstShadowedId, endId: lastShadowedId },
    shadowedIds: [...new Set([...shadowedIds, ...retiredByFiltered])],
    shadowedSeqRange: summaryFields.shadowedSeqRange,
    shadowedSeqs: summaryFields.shadowedSeqs,
    summary: summaryFields.summary,
    shadowedTokenCount: summaryFields.shadowedTokenCount,
    provider: summaryFields.provider,
    model: summaryFields.model,
    ...(summaryFields.sourceCommandId === undefined ? {} : { sourceCommandId: summaryFields.sourceCommandId }),
    ...(summaryFields.maxTokens === undefined ? {} : { maxTokens: summaryFields.maxTokens }),
    ...(summaryFields.usage === undefined ? {} : { usage: summaryFields.usage }),
  }
  // Field types are runtime-validated by extractSummaryFields; the cast
  // reconciles the union discriminant with exactOptionalPropertyTypes.
  const summary = (summaryFields.llmStreamCall === true
    ? { ...summaryBase, rawOutput: summaryFields.rawOutput as readonly ContentBlock[], llmStreamCall: true }
    : {
      ...summaryBase,
      ...(summaryFields.rawOutput === undefined ? {} : { rawOutput: summaryFields.rawOutput }),
    }) as unknown as CompactionSummary

  const seedBoundaryId = file.session.seedBoundaryId !== undefined && shadowed.has(file.session.seedBoundaryId)
    ? input.checkpointEventId
    : file.session.seedBoundaryId

  // Constructed explicitly so the parent's blobMapPage/referencesPage (which
  // address the pre-compaction full maps) are not carried into the result.
  /* jscpd:ignore-start -- record construction mirrors fork.ts; each carries its own pointers/bindings. */
  const baseBindings = new Map<EventId, BlobId>()
  for (const [eventId, blobId] of file.session.usedEventBindings ?? []) baseBindings.set(eventId, blobId)
  for (const entry of nextTree.entries()) {
    const prior = baseBindings.get(entry.eventId)
    // Compaction either keeps an existing entry's binding or mints a fresh
    // EventId, so a surviving entry never disagrees with the baseline.
    /* v8 ignore next 2 -- compaction output preserves or mints bindings; the conflict is unreachable. */
    if (prior !== undefined && prior !== entry.blobId) {
      throw new Error(`event ${entry.eventId} is immutable; a CAS update must not rebind its blob`)
    }
    baseBindings.set(entry.eventId, entry.blobId)
  }
  const nextSession: StoredSessionRecord = {
    sessionId: file.session.sessionId,
    formatVersion: file.session.formatVersion,
    nextEventCounter: input.nextEventCounter,
    ...(file.session.createdAt === undefined ? {} : { createdAt: file.session.createdAt }),
    ...(file.session.cwd === undefined ? {} : { cwd: file.session.cwd }),
    ...(file.session.parentSession === undefined ? {} : { parentSession: file.session.parentSession }),
    ...(file.session.origin === undefined ? {} : { origin: file.session.origin }),
    ...(file.session.delegationDepth === undefined ? {} : { delegationDepth: file.session.delegationDepth }),
    ...(file.session.agentPreset === undefined ? {} : { agentPreset: file.session.agentPreset }),
    // The durable EventId binding history survives compaction: retired
    // bindings stay (they cannot be rebound) and the four minted marker
    // events enter the table so a later CAS update cannot rebind them.
    usedEventBindings: baseBindings,
    rootPage: file.session.rootPage,
    revision: input.nextRevision,
    ...(seedBoundaryId === undefined ? {} : { seedBoundaryId }),
    ...(file.session.blobIdWatermark === undefined ? {} : { blobIdWatermark: file.session.blobIdWatermark }),
    backups: file.session.backups,
  }
  /* jscpd:ignore-end */

  return {
    session: nextSession,
    entries: nextTree.entries(),
    blobs: nextBlobs,
    references: nextReferences,
    // A summary whose checkpoint event is shadowed again is dropped: its
    // checkpoint no longer exists in the tree, and persisting it would make
    // the file fail the checkpoint-exists import check.
    compacted: [...file.compacted.filter(summary => !shadowed.has(summary.checkpointEventId)), summary],
  }
}

/**
 * High-level engine tying tree persistence, blob/reference pages, compaction,
 * fork, CAS, and GC together.
 * @module @deepseek-ai/dsh-session-format/engine
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { fromEntries, SessionTree, toArray, type LeafEntry } from './btree.ts'
import { performCompaction, type CompactionInput } from './compaction.ts'
import { deserializeSessionFile, isContentBlock, serializeSessionFile, type SessionFile } from './file.ts'
import { forkSessionFile } from './fork.ts'
import { collectGarbage } from './gc.ts'
import type { BlobId, CompactionSummary, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from './index.ts'
import {
  loadBlobMap,
  loadCompactionSummaries,
  loadReferences,
  saveBlobMap,
  saveCompactionSummaries,
  saveReferences,
} from './metadata.ts'
import { loadMultiPageTree, saveMultiPageTree } from './multi-page.ts'
import type { PageStore } from './page-store.ts'
import { SessionStore } from './store.ts'

/** Parse a `rev-<n>` revision token into its numeric value.
 * @param revision - revision token to parse.
 * @returns the numeric value when the token is a safe-integer `rev-<n>`, else undefined.
 */
export function parseRevision(revision: SessionRevision): number | undefined {
  const match = /^rev-(\d+)$/.exec(revision)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/** Reject a session file whose relationships do not hold before publishing.
 * @param file - session file to validate.
 */
function validateSessionFile(file: SessionFile): void {
  if (file.session.formatVersion !== 1) throw new Error('session file formatVersion must be 1')
  if (!Number.isSafeInteger(file.session.nextEventCounter) || file.session.nextEventCounter < 0) {
    throw new Error('session file nextEventCounter must be a non-negative safe integer')
  }
  // The counter is per-session: a forked child inherits parent-prefixed
  // events that must not count against its own nextEventCounter, and a child
  // session can legitimately start at 0 while hosting evt_<parent>_* entries.
  // Only ids in this session's own namespace feed the high-water mark, which
  // is exactly the rule the archive boundary applies (file.ts).
  const sessionPrefix = `evt_${file.session.sessionId}_`
  let highestUsedEventId = -1
  for (const id of file.entries.map(entry => entry.eventId)) {
    const suffix = id.startsWith(sessionPrefix) ? id.slice(sessionPrefix.length) : ''
    const value = /^\d+$/.test(suffix) ? Number(suffix) : -1
    highestUsedEventId = Math.max(highestUsedEventId, value)
  }
  for (const summary of file.compacted) {
    for (const id of [...summary.shadowedIds, summary.shadowedRange.startId, summary.shadowedRange.endId,
      summary.markerEventIds.startEventId, summary.markerEventIds.summaryEventId, summary.markerEventIds.endEventId,
      summary.checkpointEventId]) {
      const suffix = id.startsWith(sessionPrefix) ? id.slice(sessionPrefix.length) : ''
      const value = /^\d+$/.test(suffix) ? Number(suffix) : -1
      highestUsedEventId = Math.max(highestUsedEventId, value)
    }
  }
  // Retired EventIds live only in the durable binding table; they must still
  // cap the counter, or the next minted id could reuse a bound one.
  for (const eventId of file.session.usedEventBindings?.keys() ?? []) {
    const suffix = eventId.startsWith(sessionPrefix) ? eventId.slice(sessionPrefix.length) : ''
    const value = /^\d+$/.test(suffix) ? Number(suffix) : -1
    highestUsedEventId = Math.max(highestUsedEventId, value)
  }
  if (file.session.nextEventCounter <= highestUsedEventId) {
    throw new Error('session file nextEventCounter must exceed the highest used EventId number')
  }
  const blobIds = new Set(file.blobs.keys())
  const eventIds = new Set<EventId>()
  let previousOrder: number | undefined
  for (const entry of file.entries) {
    if (!blobIds.has(entry.blobId)) throw new Error(`event ${entry.eventId} references missing blob ${entry.blobId}`)
    if (!Number.isFinite(entry.order)) throw new Error(`session file entry eventId ${entry.eventId} order must be finite`)
    if (previousOrder !== undefined && entry.order <= previousOrder) {
      throw new Error('session file entries must be sorted by strictly increasing order')
    }
    if (eventIds.has(entry.eventId)) throw new Error(`session file entry eventId ${entry.eventId} is duplicated`)
    previousOrder = entry.order
    eventIds.add(entry.eventId)
  }
  if (file.session.seedBoundaryId !== undefined && !eventIds.has(file.session.seedBoundaryId)) {
    throw new Error(`seedBoundaryId ${file.session.seedBoundaryId} targets a missing event`)
  }
  const referenceKeys = new Set<string>()
  for (const reference of file.references) {
    if (!eventIds.has(reference.fromEventId)) throw new Error(`reference sources missing event ${reference.fromEventId}`)
    const key = `${reference.fromEventId}\u0000${reference.refName}`
    if (referenceKeys.has(key)) throw new Error(`duplicate reference ${reference.fromEventId}/${reference.refName}`)
    referenceKeys.add(key)
    const seenTargets = new Set<EventId>()
    for (const id of reference.toEventIds) {
      if (!eventIds.has(id)) throw new Error(`reference targets missing event ${id}`)
      if (seenTargets.has(id)) throw new Error(`reference ${reference.fromEventId}/${reference.refName} targets ${id} more than once`)
      seenTargets.add(id)
    }
  }
  // Built once for every summary below: the marker-order check and the marker
  // blob lookups resolve entries through these maps, so a file with many
  // compactions does not rebuild them per summary.
  const indexOf = new Map(file.entries.map((entry, index) => [entry.eventId, index]))
  const entryByEventId = new Map(file.entries.map(entry => [entry.eventId, entry]))
  for (const summary of file.compacted) {
    if (!eventIds.has(summary.checkpointEventId)) {
      throw new Error(`compaction summary checkpoint ${summary.checkpointEventId} is not an event`)
    }
    for (const id of summary.shadowedIds) {
      if (eventIds.has(id)) throw new Error(`compaction summary shadowedIds must not contain live event ${id}`)
    }
    for (const id of [summary.shadowedRange.startId, summary.shadowedRange.endId]) {
      if (eventIds.has(id)) throw new Error(`compaction summary shadowedRange must not contain live event ${id}`)
    }
    const shadowedSet = new Set(summary.shadowedIds)
    for (const id of [summary.shadowedRange.startId, summary.shadowedRange.endId]) {
      if (!shadowedSet.has(id)) throw new Error(`compaction summary shadowedRange endpoint ${id} must be listed in shadowedIds`)
    }
    if (summary.shadowedSeqs.length === 0
      || !summary.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)
      || summary.shadowedSeqs[0] !== summary.shadowedSeqRange.start
      || summary.shadowedSeqs[summary.shadowedSeqs.length - 1] !== summary.shadowedSeqRange.end) {
      throw new Error('compaction summary shadowedSeqs must be non-empty and span the shadowedSeqRange')
    }
    const rawSummary = summary as unknown as Record<string, unknown>
    validateSummaryShape(rawSummary)
    const markerIds = [
      summary.checkpointEventId,
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.markerEventIds.endEventId,
    ]
    for (const id of markerIds) {
      if (!eventIds.has(id)) throw new Error(`compaction summary marker ${id} must be a live event`)
    }
    if (new Set(markerIds).size !== markerIds.length) {
      throw new Error('compaction summary marker ids must be pairwise distinct')
    }
    // The marker group must appear in the entry order start, summary,
    // checkpoint, end. The archive boundary (file.ts) accepts ordinary events
    // between start and summary and between checkpoint and end — replay pairs
    // the checkpoint with the preceding summary, so only summary and
    // checkpoint must be adjacent — and the engine must accept every file the
    // archive accepts, so the same span rule applies here. LeafEntry orders
    // only need to be finite and strictly increasing (not dense integers), so
    // adjacency is judged by the entries array positions, not by `order + 1`.
    const startIndex = indexOf.get(summary.markerEventIds.startEventId) as number
    const summaryIndex = indexOf.get(summary.markerEventIds.summaryEventId) as number
    const checkpointIndex = indexOf.get(summary.checkpointEventId) as number
    const endIndex = indexOf.get(summary.markerEventIds.endEventId) as number
    // Live-event checks above guarantee every marker id is present, so each
    // index lookup resolves; the safety check guards the cast only.
    /* v8 ignore next 1 -- marker ids were checked live, so indexes always resolve. */
    if ([startIndex, summaryIndex, checkpointIndex, endIndex].some(index => !Number.isSafeInteger(index))) {
      throw new Error('compaction summary marker events must be ordered start, summary, checkpoint, end')
    }
    if (!(startIndex < summaryIndex && summaryIndex < checkpointIndex
      && checkpointIndex === summaryIndex + 1 && checkpointIndex < endIndex)) {
      throw new Error('compaction summary marker events must be ordered start, summary, checkpoint, end')
    }
    // The marker events are the physical bracket of one transaction: a summary
    // that named any four live events as markers would make fork treat ordinary
    // events as an indivisible bracket and later compactions skip their
    // surface-event checks. Verify the marker blobs carry the transaction's
    // event types, compactionId, and checkpoint source.
    const markerRoles: ReadonlyArray<readonly [EventId, string]> = [
      [summary.markerEventIds.startEventId, 'compaction/start'],
      [summary.markerEventIds.summaryEventId, 'compaction/summary'],
      [summary.markerEventIds.endEventId, 'compaction/end'],
    ]
    for (const [id, expectedType] of markerRoles) {
      const envelope = markerEnvelope(file, id, entryByEventId)
      if (envelope === undefined || envelope.type !== expectedType
        || !isRecord(envelope.data) || envelope.data.compactionId !== summary.compactionId) {
        throw new Error(`compaction summary ${expectedType} marker ${id} must belong to compaction ${summary.compactionId}`)
      }
    }
    const checkpoint = markerEnvelope(file, summary.checkpointEventId, entryByEventId)
    // The checkpoint is a user/message carrying the compaction's provenance in
    // data.source and a replace surfaceOp with exactly { op, start, end } and
    // non-negative safe integer endpoints matching the summary's shadowedSeqRange;
    // the sourceEventSeqs must cite every shadowed seq. This mirrors the archive
    // boundary (file.ts) and the compaction replay invariant, so a damaged file
    // cannot publish a checkpoint replay would not recognize.
    if (checkpoint === undefined
      || !isRecord(checkpoint.data)
      || !isRecord(checkpoint.data.source)
      || !isCompactCheckpointSource(checkpoint.data.source as unknown as never)
      || checkpoint.data.source.compactionId !== summary.compactionId
      || !isRecord(checkpoint.surfaceOp)
      || checkpoint.surfaceOp.op !== 'replace'
      || Object.keys(checkpoint.surfaceOp).length !== 3
      || typeof checkpoint.surfaceOp.start !== 'number'
      || !Number.isSafeInteger(checkpoint.surfaceOp.start)
      || checkpoint.surfaceOp.start < 0
      || typeof checkpoint.surfaceOp.end !== 'number'
      || !Number.isSafeInteger(checkpoint.surfaceOp.end)
      || checkpoint.surfaceOp.end < 0
      || checkpoint.surfaceOp.start !== summary.shadowedSeqRange.start
      || checkpoint.surfaceOp.end !== summary.shadowedSeqRange.end
      || checkpoint.type !== 'user/message') {
      throw new Error(`compaction summary checkpoint ${summary.checkpointEventId} must be a user/message surface event carrying a replace surfaceOp over the summary's shadowedSeqRange and the checkpoint source of compaction ${summary.compactionId}`)
    }
    // The sourceEventSeqs must be non-negative safe integers and cite every
    // shadowed seq; the Set turns the coverage check into O(shadowedSeqs)
    // instead of a linear scan per shadowed seq.
    const sourceSeqSet = Array.isArray(checkpoint.sourceEventSeqs) ? new Set(checkpoint.sourceEventSeqs) : undefined
    if (sourceSeqSet === undefined
      || ![...sourceSeqSet].every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
      || !summary.shadowedSeqs.every(seq => sourceSeqSet.has(seq))) {
      throw new Error(`compaction summary checkpoint ${summary.checkpointEventId} must be a user/message surface event carrying a replace surfaceOp over the summary's shadowedSeqRange and the checkpoint source of compaction ${summary.compactionId}`)
    }
  }
}

/** Validate the summary fields of one compaction summary entry.
 * Structurally checked field by field so the write side and the read-back
 * side (loadCompactionSummaries) accept the same summary set.
 * @param summary - the raw summary entry.
 */
function validateSummaryShape(summary: Record<string, unknown>): void {
  const bad = 'compaction summary entries must carry the full summary shape'
  if (!Number.isSafeInteger(summary.shadowedTokenCount) || (summary.shadowedTokenCount as number) < 0) throw new Error(bad)
  if (typeof summary.compactionId !== 'string' || summary.compactionId.length === 0) throw new Error(bad)
  if (typeof summary.provider !== 'string' || typeof summary.model !== 'string') throw new Error(bad)
  if (summary.sourceCommandId !== undefined
    && (typeof summary.sourceCommandId !== 'string' || summary.sourceCommandId.length === 0)) throw new Error(bad)
  if (summary.maxTokens !== undefined && typeof summary.maxTokens !== 'number') throw new Error(bad)
  if (summary.llmStreamCall !== undefined && summary.llmStreamCall !== true) throw new Error(bad)
  if (summary.llmStreamCall === true && summary.rawOutput === undefined) throw new Error(bad)
  if (!(summary.summary as unknown[]).every(isContentBlock)) throw new Error(bad)
  if (summary.rawOutput !== undefined && !(summary.rawOutput as unknown[]).every(isContentBlock)) throw new Error(bad)
  if (summary.usage !== undefined && !isValidUsage(summary.usage)) throw new Error(bad)
}

/** Validate a summary usage record's token fields.
 * @param usage - the raw usage value.
 * @returns true when every present token field is a number.
 */
function isValidUsage(usage: unknown): boolean {
  if (!isRecord(usage)) return false
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return false
  for (const field of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (usage[field] !== undefined && typeof usage[field] !== 'number') return false
  }
  return true
}

function markerEnvelope(
  file: SessionFile,
  eventId: EventId,
  entryByEventId: ReadonlyMap<EventId, LeafEntry>,
): Record<string, unknown> | undefined {
  const entry = entryByEventId.get(eventId)
  // Callers only pass marker ids already checked to be live events, so the
  // entry and its blob always exist here.
  /* v8 ignore next 1 -- live-event check precedes every marker lookup */
  if (entry === undefined) return undefined
  const bytes = file.blobs.get(entry.blobId)
  /* v8 ignore next 1 -- entry blob existence precedes every marker lookup */
  if (bytes === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

/** End-to-end engine over the page store and session store. */
export class SessionFormatEngine {
  constructor(
    private readonly pages: PageStore,
    private readonly store: SessionStore,
  ) {}

  /** Persist a session file and register its record.
   * A new session is registered directly; updating an existing session
   * requires the current revision so the replacement goes through the
   * compare-and-swap commit and cannot roll a newer revision back.
   * @param file - session file to persist.
   * @param expectedRevision - current revision when replacing an existing session.
   * @returns the registered session record.
   */
  saveSession(file: SessionFile, expectedRevision?: SessionRevision): StoredSessionRecord {
    validateSessionFile(file)
    // The archive boundary must accept what the engine publishes: a file that
    // serializes but fails deserializeSessionFile (for example a marker blob
    // missing its turn, or a checkpoint whose surfaceOp range disagrees with
    // the summary) would be rejected at export/import and at real replay, so
    // it must not be committed here either.
    deserializeSessionFile(serializeSessionFile(file))
    if (expectedRevision === undefined) {
      if (this.store.getSession(file.session.sessionId) !== undefined) {
        throw new Error(`session ${file.session.sessionId} already exists; pass its revision to update via CAS`)
      }
      // A registered session must be advanceable: a malformed, non-finite, or
      // ceiling token would freeze the session for every later commit. Reject
      // it at registration, the earliest point.
      const initial = parseRevision(file.session.revision)
      if (initial === undefined || initial >= Number.MAX_SAFE_INTEGER - 1) {
        throw new Error(`session revision must be an advanceable safe-integer rev-<n> token, got ${file.session.revision}`)
      }
      // A fresh session's used-bindings baseline is its own entries, merged
      // with any bindings the file already carries (an import/export restore
      // keeps historical bindings for retired EventIds). A conflict — the
      // file binds an EventId differently from its own table — is rejected.
      const usedEventBindings = new Map<EventId, BlobId>()
      for (const [eventId, blobId] of file.session.usedEventBindings ?? []) {
        usedEventBindings.set(eventId, blobId)
      }
      for (const entry of file.entries) {
        const prior = usedEventBindings.get(entry.eventId)
        // The archive boundary (file.ts) already rejects a file whose live
        // entry conflicts with its own binding table, so this guard is
        // defensive against hand-built in-memory files.
        /* v8 ignore next 2 -- the file boundary rejects conflicts first. */
        if (prior !== undefined && prior !== entry.blobId) {
          throw new Error(`event ${entry.eventId} is immutable; its binding conflicts with the file's usedEventBindings`)
        }
        usedEventBindings.set(entry.eventId, entry.blobId)
      }
      const record = this.buildRecord(file, usedEventBindings)
      this.store.putSession(record)
      return record
    }
    // A missing session is a caller error; surface it before the CAS miss
    // below would report a revision mismatch.
    if (!this.hasSession(file.session.sessionId)) {
      throw new Error(`session ${file.session.sessionId} not found`)
    }
    // Updates go through commitSession, the single strictly-advancing CAS
    // commit point, which validates the revision advance, enforces blob
    // immutability and counter monotonicity (only when the expected revision
    // matches, so a stale snapshot surfaces as a CAS miss rather than a
    // misleading invariant error), rejects rebinding a used EventId and
    // foreign-prefix EventIds, and folds every binding into the durable
    // table.
    const record = this.commitSession(file, expectedRevision)
    if (record === undefined) {
      throw new Error(`session ${file.session.sessionId} revision mismatch`)
    }
    return record
  }

  /** Whether a session record is registered.
   * @param sessionId - session id to check.
   * @returns true when the session is registered.
   */
  hasSession(sessionId: SessionId): boolean {
    return this.store.getSession(sessionId) !== undefined
  }

  /** Persist one strictly-advancing compare-and-swap commit.
   * Blob payloads, the EventId counter, and the EventId→blob binding table
   * are immutable: only a snapshot derived from the stored generation can
   * rewrite them, so a stale expected revision is a CAS miss that returns
   * undefined and lets the caller reload and retry. The committed record
   * always carries the advanced revision and the folded binding baseline.
   * @param file - the next file snapshot, carrying the advanced revision.
   * @param expectedRevision - the revision the snapshot was derived from.
   * @returns the stored record after the commit, or undefined when the
   * revision moved.
   */
  commitSession(file: SessionFile, expectedRevision: SessionRevision): StoredSessionRecord | undefined {
    validateSessionFile(file)
    const stored = this.store.getSession(file.session.sessionId)
    // An unknown session is a CAS miss, not an invariant violation: no
    // current generation exists to validate the snapshot against, so the
    // caller can register and retry.
    if (stored === undefined) return undefined
    const next = parseRevision(file.session.revision)
    const current = parseRevision(expectedRevision)
    // Only a snapshot derived from the stored generation can rewrite an
    // existing blob payload or regress the counter; a stale expected
    // revision is a CAS miss that must return undefined so callers can
    // reload and retry, even when the stale snapshot mints a colliding blob
    // id with different bytes (two writers deriving from the same revision).
    if (stored.revision === expectedRevision) {
      // Blob payloads are immutable: the blob map and every rolling backup
      // must resolve the same bytes for the same id, so a CAS update cannot
      // rewrite a payload a consumer may still hold.
      const priorBytes = new Map<BlobId, Uint8Array>()
      if (stored.blobMapPage !== undefined) {
        for (const [blobId, bytes] of loadBlobMap(this.pages, stored.blobMapPage)) priorBytes.set(blobId, bytes)
      }
      for (const backup of stored.backups) {
        if (backup.blobMapPage === undefined) continue
        for (const [blobId, bytes] of loadBlobMap(this.pages, backup.blobMapPage)) {
          if (!priorBytes.has(blobId)) priorBytes.set(blobId, bytes)
        }
      }
      for (const [blobId, bytes] of file.blobs) {
        const prior = priorBytes.get(blobId)
        if (prior !== undefined && (bytes.length !== prior.length || bytes.some((byte, index) => byte !== prior[index]))) {
          throw new Error(`blob ${blobId} is immutable; a CAS update must not rewrite its content`)
        }
      }
      if (file.session.nextEventCounter < stored.nextEventCounter) {
        throw new Error(`committed nextEventCounter ${file.session.nextEventCounter} regresses the stored counter ${stored.nextEventCounter}`)
      }
    }
    // The replacement must strictly advance the revision; a malformed or
    // non-advancing expected token is a caller error, surfaced here.
    if (next === undefined || current === undefined || next <= current) {
      throw new Error(
        `revision mismatch: committed revision ${file.session.revision} must advance past the expected revision ${expectedRevision}`,
      )
    }
    // Fold every binding in the next generation into the durable map so the
    // baseline advances with the commit: the map starts from the stored
    // table and the current generation's entries (a record imported without
    // the table still pins every live entry), and only grows (an EventId is
    // never unbound once minted). A surviving entry must keep its binding,
    // and a newly minted id must live in this session's own namespace.
    const previous = this.loadSession(file.session.sessionId)
    const usedEventBindings = new Map<EventId, BlobId>()
    for (const [eventId, blobId] of stored.usedEventBindings ?? []) usedEventBindings.set(eventId, blobId)
    for (const entry of previous.entries) {
      const prior = usedEventBindings.get(entry.eventId)
      // loadSession validated the stored record against the archive
      // boundary, which rejects a live-entry/table conflict, so this is
      // defensive.
      /* v8 ignore next 2 -- the file boundary rejects binding conflicts first. */
      if (prior !== undefined && prior !== entry.blobId) {
        throw new Error(`event ${entry.eventId} is immutable; its binding conflicts with the file's usedEventBindings`)
      }
      usedEventBindings.set(entry.eventId, entry.blobId)
    }
    const ownPrefix = `evt_${file.session.sessionId}_`
    for (const entry of file.entries) {
      const prior = usedEventBindings.get(entry.eventId)
      if (prior !== undefined && prior !== entry.blobId) {
        throw new Error(`event ${entry.eventId} is immutable; a CAS update must not rebind its blob`)
      }
      // performCompaction and the repository mint ids in the session
      // namespace, so a foreign-prefix new id is unreachable; the guard is
      // defensive against hand-built inputs.
      /* v8 ignore next 3 -- minted ids carry the session prefix. */
      if (prior === undefined && !entry.eventId.startsWith(ownPrefix)) {
        throw new Error(`event ${entry.eventId} must use this session's own EventId prefix`)
      }
      usedEventBindings.set(entry.eventId, entry.blobId)
    }
    const record = this.buildRecord(file, usedEventBindings)
    if (!this.store.commit(file.session.sessionId, record, expectedRevision)) return undefined
    // The commit appends the previous generation to backups; return the
    // stored record so the caller sees the published state.
    /* v8 ignore start -- a successful commit guarantees the record is present; the fallback is defensive only. */
    const published = this.store.getSession(file.session.sessionId)
    if (published === undefined) throw new Error(`session ${file.session.sessionId} not found after commit`)
    /* v8 ignore stop */
    return published
  }

  /** Load a session file from the page store.
   * @param sessionId - session to load.
   * @returns the reconstructed session file.
   */
  loadSession(sessionId: SessionId): SessionFile {
    const record = this.store.getSession(sessionId)
    if (record === undefined) throw new Error(`session ${sessionId} not found`)
    const tree = SessionTree.fromEntries(toArray(loadMultiPageTree(this.pages, record.rootPage)))
    const blobs = record.blobMapPage === undefined
      ? new Map()
      : loadBlobMap(this.pages, record.blobMapPage)
    const references = record.referencesPage === undefined
      ? []
      : loadReferences(this.pages, record.referencesPage)
    const compacted = record.compactedPage === undefined
      ? []
      : loadCompactionSummaries(this.pages, record.compactedPage)
    const file: SessionFile = {
      session: record,
      entries: tree.entries(),
      blobs,
      references,
      compacted,
    }
    // Durable reads fail at the earliest resolvable point: a stored record
    // that cannot pass the file invariants — including the archive boundary
    // the publish path enforces — must not be handed back. The round-trip
    // rejects states validateSessionFile alone would accept (for example a
    // checkpoint blob missing its time or message fields), so a record
    // restored by putSession or a future backend cannot surface a file that
    // export/import or real replay would refuse.
    validateSessionFile(file)
    deserializeSessionFile(serializeSessionFile(file))
    return file
  }

  /** Run one physical compaction with a CAS commit.
   * @param sessionId - session to compact.
   * @param input - compaction inputs.
   * @param replacementBlobs - payloads for the replacement event blobs, written
   * into the session's blob map inside the same transaction.
   * @param nextWatermark - the blob-id high-water to persist on the committed
   * record, so a dropped blob id is never reused; omitted keeps the file's.
   * @returns the recorded compaction summary, or undefined when the commit
   * failed. The CAS-miss return is unreachable while the engine is
   * synchronous (the expected revision is loaded in the same call); it
   * documents the contract a future async backend keeps.
   */
  compact(
    sessionId: SessionId,
    input: CompactionInput,
    replacementBlobs?: ReadonlyMap<BlobId, Uint8Array>,
    nextWatermark?: number,
  ): CompactionSummary | undefined {
    const file = this.loadSession(sessionId)
    const blobs = new Map(file.blobs)
    if (replacementBlobs !== undefined) {
      for (const [blobId, payload] of replacementBlobs) {
        if (blobs.has(blobId)) throw new Error(`replacement blob ${blobId} already exists in the session`)
        blobs.set(blobId, payload)
      }
    }
    const nextFile = performCompaction({ ...file, blobs }, input)
    validateSessionFile(nextFile)
    // A committed root must round-trip through the durable container so a
    // serialization defect never lands in the store.
    deserializeSessionFile(serializeSessionFile(nextFile))
    // Omitted nextWatermark keeps the loaded file's watermark: a direct
    // engine.compact call must not wipe the persisted high-water.
    const watermark = nextWatermark ?? file.session.blobIdWatermark
    const record = this.commitSession(
      watermark === undefined ? nextFile : { ...nextFile, session: { ...nextFile.session, blobIdWatermark: watermark } },
      file.session.revision,
    )
    /* v8 ignore next 2 -- defensive: commitSession rejects a stale expected revision */
    if (record === undefined) return undefined
    const summaries = nextFile.compacted
    return summaries[summaries.length - 1]
  }

  /** Fork a session and register the child.
   * @param parentId - parent session id.
   * @param atEventId - fork boundary event id, included in the child.
   * @param childId - session id of the child; must be new and differ from the parent.
   * @returns the registered child record.
   */
  fork(parentId: SessionId, atEventId: EventId, childId: SessionId): StoredSessionRecord {
    if (childId === parentId) throw new Error(`fork requires a new session id, got ${childId}`)
    if (this.store.getSession(childId) !== undefined) throw new Error(`session ${childId} already exists`)
    const parent = this.loadSession(parentId)
    // The child continues the parent's id lineage, so it inherits the parent
    // nextEventCounter rather than restarting at 0; the per-session namespace
    // filter keeps parent-prefixed events out of the child's high-water mark,
    // so the inherited counter never falsely rejects the child. Restarting at
    // 0 would also be valid and is considered for the durable backend.
    const child = forkSessionFile(parent, atEventId, childId, {
      rootPage: 'page_placeholder' as PageId,
      revision: 'rev-0' as SessionRevision,
      nextEventCounter: parent.session.nextEventCounter,
    })
    return this.saveSession(child)
  }

  /** Collect unreachable pages across all registered sessions.
   * @returns the number of pages removed.
   */
  gc(): number {
    return collectGarbage(this.pages, this.store.sessions())
  }

  private buildRecord(file: SessionFile, usedEventBindings: Map<EventId, BlobId>): StoredSessionRecord {
    const rootPage = saveMultiPageTree(this.pages, fromEntries(file.entries))
    const blobMapPage = saveBlobMap(this.pages, file.blobs)
    const referencesPage = saveReferences(this.pages, file.references)
    const compactedPage = saveCompactionSummaries(this.pages, file.compacted)
    return {
      ...file.session,
      usedEventBindings: new Map(usedEventBindings),
      rootPage,
      blobMapPage,
      referencesPage,
      compactedPage,
      // SessionStore.commit is the sole owner of backup bookkeeping; a
      // fresh registration must not inherit the input file's backups.
      backups: [],
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

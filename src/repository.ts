/**
 * High-level session repository over the engine.
 * This is the integration surface that a future Cordis persistence plugin can
 * wrap: it owns the read-modify-write transactions (append, compact, fork)
 * that the engine deliberately does not expose as blind replaces, and it
 * assigns the system-generated EventId/BlobId pairs for appended events.
 * Blob payloads have one authority — the session file's blob map persisted by
 * the engine — and are read back through loadSession.
 * @module @deepseek-ai/dsh-session-format/repository
 */

import { SessionTree } from './btree.ts'
import type { CompactionInput } from './compaction.ts'
import { parseRevision, SessionFormatEngine } from './engine.ts'
import type { SessionFile } from './file.ts'
import type { BlobId, CompactionSummary, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from './index.ts'
import { projectionNeedsRebuild } from './projection.ts'
import type { ProjectionState } from './projection.ts'

/**
 * A session file whose root page, initial revision, and backups are assigned
 * by the repository on registration. The revision, when supplied, must be in
 * the `rev-<n>` form the compare-and-swap commit advances; backups are always
 * empty for a fresh registration.
 */
export type NewSessionFile = Omit<SessionFile, 'session'> & {
  readonly session: Omit<StoredSessionRecord, 'rootPage' | 'revision' | 'backups'> & {
    readonly revision?: string
  }
}

/**
 * Next EventId for a session: the persisted `nextEventCounter` is minted as
 * the suffix (the first minted id equals the counter, which the commit then
 * advances), advanced past every larger trailing numeric counter seen in the
 * session's events or in any recorded compaction's shadowed EventIds.
 * Compaction summaries persist every shadowed id and the record persists the
 * advanced counter, so the counter never regresses after a compaction removes
 * the current maximum.
 * @param file - the current session file.
 * @param sessionId - the session the new event belongs to.
 * @returns the minted EventId and the numeric counter it carries.
 */
function nextEventId(file: SessionFile, sessionId: SessionId): { id: EventId; counter: number } {
  let counter = file.session.nextEventCounter
  const consider = (id: EventId): void => {
    const match = /_(\d+)$/.exec(id)
    if (match !== null) {
      const value = Number(match[1])
      // Registration rejects a file whose entries carry an unsafe or ceiling
      // numeric part, so this guard is defensive only.
      /* v8 ignore next 3 -- unreachable via repository-managed sessions */
      if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`event counter ${match[1]} exceeds the safe integer range`)
      }
      // A registered file's counter always exceeds every entry, so the
      // monotonic advance is defensive for imported sparseness only.
      /* v8 ignore next 1 -- unreachable via registered sessions */
      if (value >= counter) counter = value + 1
    }
  }
  for (const entry of file.entries) consider(entry.eventId)
  for (const summary of file.compacted) {
    for (const id of summary.shadowedIds) consider(id)
  }
  if (counter >= Number.MAX_SAFE_INTEGER) {
    throw new Error('event counter cannot advance within the safe integer range')
  }
  return { id: `evt_${sessionId}_${counter}` as EventId, counter }
}

/** Numeric part of a canonical `blob_<n>` id, or undefined for any other id.
 * @param id - blob id to parse.
 * @returns the numeric value when the id is a safe-integer `blob_<n>`, else undefined.
 */
function blobNumeric(id: BlobId): number | undefined {
  const match = /^blob_(\d+)$/.exec(id)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Next BlobId for a session: one above the persisted watermark and every
 * numeric id in the blob map, so a payload dropped by a compaction is never
 * reassigned to different bytes.
 * @param file - the current session file.
 * @returns a BlobId above every id the session has used.
 */
function nextBlobId(file: SessionFile): BlobId {
  // Allocation is monotonic over the persisted watermark and the ids present,
  // so a blob id is never reassigned to different bytes after its payload was
  // dropped by a compaction: a consumer holding the id across generations
  // always resolves the same immutable payload.
  let next = file.session.blobIdWatermark ?? -1
  for (const id of file.blobs.keys()) {
    const value = blobNumeric(id)
    if (value !== undefined && value > next) next = value
  }
  if (next >= Number.MAX_SAFE_INTEGER) {
    throw new Error('session blob counter cannot advance within the safe integer range')
  }
  return `blob_${next + 1}` as BlobId
}

/**
 * The revision following a given one.
 * @param revision - the current revision, in the `rev-<n>` form.
 * @returns the next revision.
 */
function nextRevision(revision: SessionRevision): SessionRevision {
  const current = parseRevision(revision)
  // Stored revisions are always advanceable safe-integer tokens (createSession
  // and the engine validate them), so only the ceiling advance is reachable.
  /* v8 ignore next 1 -- defensive: stored revisions always parse as safe tokens */
  if (current === undefined) throw new Error(`revision ${revision} is not a rev-<n> token`)
  // A registered session always advances at least once (createSession rejects
  // ceiling revisions); this guard stops a session that has reached the
  // ceiling revision from minting a token no later commit can advance.
  if (current >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error(`revision ${revision} cannot advance within the safe integer range`)
  }
  return `rev-${current + 1}` as SessionRevision
}

/** Application-facing repository for the new session format. */
export class SessionRepository {
  /**
   * Wrap an engine with the repository's transaction semantics.
   * @param engine - the engine whose page store and session store back this repository.
   */
  constructor(private readonly engine: SessionFormatEngine) {}

  /**
   * Register a new session file. The repository assigns the root page and
   * empty backups; the initial revision is the caller's `rev-<n>` value
   * (default `rev-0`). An already-registered session id is rejected.
   * @param file - the session file; rootPage and backups are assigned here.
   * @returns the registered session record.
   */
  createSession(file: NewSessionFile): StoredSessionRecord {
    if (this.engine.hasSession(file.session.sessionId)) {
      throw new Error(`session ${file.session.sessionId} already exists`)
    }
    const revision = (file.session.revision ?? 'rev-0') as SessionRevision
    const current = parseRevision(revision)
    if (current === undefined) {
      throw new Error(`session revision must be in rev-<n> form, got ${revision}`)
    }
    if (current >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error(`session revision ${revision} cannot advance within the safe integer range`)
    }
    if (file.session.seedBoundaryId !== undefined
      && !file.entries.some(entry => entry.eventId === file.session.seedBoundaryId)) {
      throw new Error(`session seed boundary ${file.session.seedBoundaryId} must reference a present event`)
    }
    if (file.session.blobIdWatermark !== undefined
      && (!Number.isSafeInteger(file.session.blobIdWatermark) || file.session.blobIdWatermark < 0)) {
      throw new Error('session blobIdWatermark must be a non-negative safe integer')
    }
    if (file.session.createdAt !== undefined
      && (!Number.isSafeInteger(file.session.createdAt) || file.session.createdAt < 0)) {
      throw new Error('session createdAt must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(file.session.nextEventCounter) || file.session.nextEventCounter < 0) {
      throw new Error('session nextEventCounter must be a non-negative safe integer')
    }
    return this.engine.saveSession({
      ...file,
      session: {
        ...file.session,
        revision,
        // Backups are always empty on registration: a snapshot-carried backup
        // holds page pointers whose bytes are not present in this page store,
        // so retaining them would make GC traverse missing pages.
        backups: [],
        rootPage: `page_${file.session.sessionId}` as PageId,
      },
    })
  }

  /**
   * Load a session file by id, including its event entries and blob map.
   * @param sessionId - the session to load.
   * @returns the loaded session file.
   */
  loadSession(sessionId: SessionId): SessionFile {
    return this.engine.loadSession(sessionId)
  }

  /**
   * Append one event with its payload. The EventId and BlobId are assigned by
   * the repository, the revision is advanced, and the new root is published
   * through the engine's compare-and-swap commit.
   * @param sessionId - the session to append to.
   * @param payload - the event payload bytes.
   * @returns the committed session record, or undefined when a concurrent
   * writer advanced the session first.
   */
  append(sessionId: SessionId, payload: Uint8Array): StoredSessionRecord | undefined {
    const file = this.engine.loadSession(sessionId)
    const { id: eventId, counter } = nextEventId(file, sessionId)
    const blobId = nextBlobId(file)
    const watermark = blobNumeric(blobId)
    // nextBlobId only mints canonical `blob_<n>` ids, so the fallback branch
    // is unreachable through the repository.
    /* v8 ignore next 1 -- defensive: nextBlobId only mints canonical blob_<n> ids */
    if (watermark === undefined) throw new Error('session blob id watermark must be numeric')
    const session = {
      ...file.session,
      blobIdWatermark: watermark,
      nextEventCounter: counter + 1,
    }
    const tree = SessionTree.fromEntries(file.entries).append(eventId, blobId)
    const blobs = new Map(file.blobs)
    blobs.set(blobId, payload)
    const nextFile: SessionFile = {
      ...file,
      session: { ...session, revision: nextRevision(file.session.revision) },
      entries: tree.entries(),
      blobs,
    }
    return this.engine.commitSession(nextFile, file.session.revision)
  }

  /**
   * Run a physical compaction transaction with a compare-and-swap commit. The
   * repository owns revision advancement: the committed record always carries
   * the revision following the current one, and the replacement event blobs
   * are written into the session's blob map inside the same transaction.
   * @param sessionId - the session to compact.
   * @param input - the compaction range and replacement event inputs.
   * @param replacementBlobs - payloads for the four replacement event blobs.
   * @returns the recorded compaction summary, or undefined when the commit
   * failed. The CAS-miss return is unreachable through this synchronous
   * composition (the expected revision is loaded in the same call); it
   * documents the contract a future async backend keeps.
   */
  compact(
    sessionId: SessionId,
    input: Omit<CompactionInput, 'nextRevision' | 'nextEventCounter'>,
    replacementBlobs: ReadonlyMap<BlobId, Uint8Array>,
  ): CompactionSummary | undefined {
    const file = this.engine.loadSession(sessionId)
    // The four replacement event ids must never resolve to an event that an
    // earlier compaction already shadowed: a stale watermark or fork boundary
    // holding such an id would silently point at the new event.
    const shadowed = new Set<EventId>()
    for (const summary of file.compacted) {
      for (const id of summary.shadowedIds) shadowed.add(id)
    }
    for (const id of [input.startEventId, input.summaryEventId, input.checkpointEventId, input.endEventId]) {
      if (shadowed.has(id)) {
        throw new Error(`replacement EventId ${id} was shadowed by an earlier compaction`)
      }
    }
    // This transaction must supply all four replacement payloads; a payload
    // left over in the file would otherwise be accepted with stale content.
    // The replacement blob ids must also advance past the persisted watermark,
    // so a compaction can never reintroduce a dropped id with different bytes.
    let watermark = file.session.blobIdWatermark ?? -1
    for (const id of file.blobs.keys()) {
      const value = blobNumeric(id)
      if (value !== undefined && value > watermark) watermark = value
    }
    let nextWatermark = watermark
    for (const id of [input.startBlobId, input.summaryBlobId, input.checkpointBlobId, input.endBlobId]) {
      if (!replacementBlobs.has(id)) {
        throw new Error(`replacement blob ${id} must be provided by this transaction`)
      }
      const value = blobNumeric(id)
      if (value === undefined || value <= watermark) {
        throw new Error(`replacement blob ${id} must advance past the blob watermark ${watermark}`)
      }
      if (value > nextWatermark) nextWatermark = value
    }
    // The replacement ids must be canonical `evt_<sessionId>_<n>` tokens with
    // a safe-integer tail at or above the persisted event counter: the
    // counter is the id high-water, and an id it has already advanced past is
    // retired or reserved and must not be rebound to a new event (the same
    // rule the replacement blob ids follow).
    const sessionPrefix = `evt_${file.session.sessionId}_`
    let replacementMax = -1
    for (const id of [input.startEventId, input.summaryEventId, input.checkpointEventId, input.endEventId]) {
      if (!id.startsWith(sessionPrefix) || !/^\d+$/.test(id.slice(sessionPrefix.length))) {
        throw new Error(`replacement EventId ${id} must carry the session prefix and a numeric suffix`)
      }
      const value = Number(id.slice(sessionPrefix.length))
      if (!Number.isSafeInteger(value) || value < file.session.nextEventCounter) {
        throw new Error(`replacement EventId ${id} must carry a safe-integer tail at or above the event counter ${file.session.nextEventCounter}`)
      }
      if (value > replacementMax) replacementMax = value
    }
    // The compacted record's event counter must sit above every replacement
    // EventId this transaction mints; the high-water check above keeps the
    // derived counter at or above the persisted counter.
    const nextCounter = replacementMax + 1
    if (!Number.isSafeInteger(nextCounter) || nextCounter >= Number.MAX_SAFE_INTEGER) {
      throw new Error('session event counter cannot advance within the safe integer range')
    }
    const next: CompactionInput = {
      ...input,
      nextRevision: nextRevision(file.session.revision),
      nextEventCounter: nextCounter,
    }
    return this.engine.compact(sessionId, next, replacementBlobs, nextWatermark)
  }

  /**
   * Whether a projection must be rebuilt after a compaction. The repository
   * owns the compaction flow and the session tree, so it supplies the stream
   * ranks: a projection is stale when it folded through the shadowed range —
   * its watermark is one of the shadowed ids, or ranks at or after the
   * compaction's checkpoint event in the current tree. The projection must
   * cover the complete prefix from the session's first event through the
   * watermark, matching the fold contract of {@link advanceProjection}; a
   * suffix-folded projection can be reported stale even though it never saw
   * the shadowed events, which only causes an unnecessary rebuild. This is a
   * one-shot check: the projection must be the pre-compaction state; a
   * projection already rebuilt over the checkpoint also ranks after it and
   * reports stale. The caller checks once per compaction and does not
   * re-check a rebuilt projection against the same summary. When the
   * watermark or the checkpoint is absent from the current tree, a later
   * compaction reordered the stream and the check reports stale.
   * @param sessionId - the session the projection folds.
   * @param projection - the projection state to check, or undefined when nothing has been folded yet.
   * @param summary - the compaction summary returned by {@link compact}.
   * @returns true when the projection folded through the summary's shadowed range.
   */
  projectionNeedsRebuild<T>(
    sessionId: SessionId,
    projection: ProjectionState<T> | undefined,
    summary: CompactionSummary,
  ): boolean {
    const file = this.engine.loadSession(sessionId)
    const tree = SessionTree.fromEntries(file.entries)
    return projectionNeedsRebuild(projection, summary, eventId => tree.rank(eventId))
  }

  /**
   * Fork a session at an EventId boundary and register the child session.
   * @param parentId - the parent session to fork from.
   * @param atEventId - the inclusive fork boundary; the child inherits the parent prefix through this event.
   * @param childId - the new child session id.
   * @returns the child session record.
   */
  fork(parentId: SessionId, atEventId: EventId, childId: SessionId): StoredSessionRecord {
    return this.engine.fork(parentId, atEventId, childId)
  }

  /**
   * Collect pages unreachable from any registered session record, its rolling
   * backups, or its metadata pages.
   * @returns how many pages were removed.
   */
  gc(): number {
    return this.engine.gc()
  }
}

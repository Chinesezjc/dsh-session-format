/**
 * Prototype session store with revision compare-and-swap and rolling backups.
 * @module @deepseek-ai/dsh-session-format/store
 */

import type { BlobId, EventId, SessionId, SessionRevision, StoredSessionBackup, StoredSessionRecord } from './index.ts'

/** Default number of old roots retained as rolling backups. */
export const DEFAULT_MAX_BACKUP_GENERATIONS = 3

/** A session store that owns session records and commits roots via CAS. */
export class SessionStore {
  private readonly records = new Map<SessionId, StoredSessionRecord>()
  private readonly usedRevisions = new Map<SessionId, Set<SessionRevision>>()
  /** The session's used-bindings table, owned by the store and extended
   * incrementally: an append adds its new binding to this map in O(1) instead
   * of copying the whole table into the record, so append stays O(log n).
   * `records` carries the same table for whole-snapshot commits. */
  private readonly bindings = new Map<SessionId, Map<EventId, BlobId>>()

  constructor(private readonly maxBackupGenerations = DEFAULT_MAX_BACKUP_GENERATIONS) {
    // A fractional cap would truncate the splice count and silently retain
    // more generations than configured; NaN would skip both trim branches and
    // grow backups without bound. The cap is a count, so it must be an exact
    // non-negative integer up front.
    if (!Number.isSafeInteger(maxBackupGenerations) || maxBackupGenerations < 0) {
      throw new Error('maxBackupGenerations must be a non-negative safe integer')
    }
  }

  /** Register or replace a session record.
   * @param record - session record to store.
   */
  putSession(record: StoredSessionRecord): void {
    if (this.records.has(record.sessionId)) {
      throw new Error(`session ${record.sessionId} already registered`)
    }
    if (!Number.isSafeInteger(record.nextEventCounter) || record.nextEventCounter < 0) {
      throw new Error('session nextEventCounter must be a non-negative safe integer')
    }
    // Store a defensive copy so later caller-side mutation cannot bypass the
    // revision CAS and backup bookkeeping, and trim any over-cap backups a
    // caller imported so the cap holds before the first commit.
    const stored = copyRecord(record)
    let backups = stored.backups
    if (this.maxBackupGenerations <= 0) backups = []
    else if (backups.length > this.maxBackupGenerations) {
      backups = backups.slice(backups.length - this.maxBackupGenerations)
    }
    const { usedEventBindings: table, ...rest } = stored
    this.bindings.set(stored.sessionId, new Map(table ?? []))
    this.records.set(stored.sessionId, { ...rest, backups })
    this.markUsed(stored.sessionId, stored.revision)
  }

  /** Read a session record, or undefined when absent.
   * @param sessionId - session id to read.
   * @returns a defensive copy of the record, or undefined when absent.
   */
  getSession(sessionId: SessionId): StoredSessionRecord | undefined {
    const record = this.records.get(sessionId)
    if (record === undefined) return undefined
    const table = this.bindings.get(sessionId)
    return copyRecord(table === undefined ? record : { ...record, usedEventBindings: new Map(table) })
  }

  /** Read a session record without assembling its used-bindings table.
   * Append paths need only the control fields (root, revision, counters,
   * page pointers), so this read stays O(1) in the binding count.
   * @param sessionId - session id to read.
   * @returns the stored record without its binding table, or undefined when absent.
   */
  getRecord(sessionId: SessionId): StoredSessionRecord | undefined {
    const record = this.records.get(sessionId)
    return record === undefined ? undefined : copyRecord(record)
  }

  /** All session records currently registered.
   * @returns defensive copies of every registered record.
   */
  sessions(): StoredSessionRecord[] {
    return [...this.records.values()].map(copyRecord)
  }

  /** Commit a replacement record only when the expected revision still matches.
   * The full previous generation (every page pointer) is appended to the
   * rolling backups on success; this store is the sole owner of backup
   * bookkeeping. `additionalBindings` names the bindings this commit adds to
   * the session's used-bindings table; the in-memory store already carries
   * them inside `next.usedEventBindings`, so it ignores the argument (the
   * durable store appends them to its binding log to keep record writes
   * O(1)).
   * @param sessionId - session to commit.
   * @param next - replacement record.
   * @param expectedRevision - revision the commit is compared against.
   * @param additionalBindings - bindings newly added by this commit, used by
   * durable backends to persist the binding table incrementally.
   * @returns true when the commit landed, false when the expected revision was stale.
   */
  commit(
    sessionId: SessionId,
    next: StoredSessionRecord,
    expectedRevision: SessionRevision,
    additionalBindings?: ReadonlyMap<EventId, BlobId>,
  ): boolean {
    const current = this.records.get(sessionId)
    // The replacement must advance the revision: accepting an unchanged token
    // would let a stale snapshot commit again over a newer state.
    if (next.sessionId !== sessionId
      || current === undefined
      || current.revision !== expectedRevision
      || next.revision === expectedRevision
      // Rejecting any previously used revision stops A -> B -> A ABA reuse,
      // which would let an old snapshot commit again over newer state.
      || this.usedRevisions.get(sessionId)?.has(next.revision) === true
      // The EventId counter is a monotonic high watermark; a commit that
      // lowers it (or carries a non-finite value, which NaN comparisons
      // would let through) would reuse ids already allocated or compacted.
      || !Number.isSafeInteger(next.nextEventCounter)
      || next.nextEventCounter < current.nextEventCounter
      // The EventId binding table is monotonic: every binding in the current
      // record must survive into the next with the same blob, or a commit
      // could silently rewrite EventId history and let a later rebind pass. An
      // incremental commit (additionalBindings present) appends to the store's
      // table instead and only rejects a conflicting append; a whole-snapshot
      // commit checks the full monotonicity.
      || (additionalBindings !== undefined
        ? !bindingsAppendable(this.bindings.get(sessionId), additionalBindings)
        : !bindingMonotonic(this.bindings.get(sessionId), next.usedEventBindings))) {
      return false
    }
    const backup: StoredSessionBackup = {
      rootPage: current.rootPage,
      ...(current.blobMapPage === undefined ? {} : { blobMapPage: current.blobMapPage }),
      ...(current.referencesPage === undefined ? {} : { referencesPage: current.referencesPage }),
      ...(current.compactedPage === undefined ? {} : { compactedPage: current.compactedPage }),
      ...(current.seedBoundaryId === undefined ? {} : { seedBoundaryId: current.seedBoundaryId }),
    }
    const backups = [...current.backups, backup]
    // Trim to the configured cap in one pass so an imported record that
    // already exceeds the cap (or a lowered cap) never stays over it.
    if (this.maxBackupGenerations <= 0) backups.length = 0
    else if (backups.length > this.maxBackupGenerations) {
      backups.splice(0, backups.length - this.maxBackupGenerations)
    }
    // The binding table is extended in place: the monotonicity checks above
    // already rejected any conflicting rebind, so appending the added
    // bindings costs O(added) instead of copying the whole table.
    let nextBindings = this.bindings.get(sessionId)
    if (nextBindings === undefined) {
      nextBindings = new Map()
      this.bindings.set(sessionId, nextBindings)
    }
    for (const [eventId, blobId] of additionalBindings ?? next.usedEventBindings ?? []) {
      nextBindings.set(eventId, blobId)
    }
    const { usedEventBindings: _table, ...rest } = next
    this.records.set(sessionId, { ...rest, backups })
    this.markUsed(sessionId, next.revision)
    return true
  }

  private markUsed(sessionId: SessionId, revision: SessionRevision): void {
    let used = this.usedRevisions.get(sessionId)
    if (used === undefined) {
      used = new Set()
      this.usedRevisions.set(sessionId, used)
    }
    used.add(revision)
  }
}

function copyRecord(record: StoredSessionRecord): StoredSessionRecord {
  return {
    ...record,
    ...(record.usedEventBindings === undefined ? {} : { usedEventBindings: new Map(record.usedEventBindings) }),
    backups: record.backups.map(backup => ({ ...backup })),
  }
}

/** Whether every binding in the current table survives into the next table.
 * The binding table only grows; a next record that drops or rewrites an
 * existing binding would let a later update rebind a retired EventId.
 * @param current - the current binding table, or undefined when absent.
 * @param next - the replacement binding table, or undefined when absent.
 * @returns true when every current binding appears unchanged in next.
 */
function bindingMonotonic(
  current: ReadonlyMap<EventId, BlobId> | undefined,
  next: ReadonlyMap<EventId, BlobId> | undefined,
): boolean {
  if (current === undefined) return true
  for (const [eventId, blobId] of current) {
    if (next?.get(eventId) !== blobId) return false
  }
  return true
}

/** Whether appending bindings to the current table never rebinds an existing
 * EventId to a different blob. The incremental append path mints fresh ids,
 * so the check is O(added); a conflict marks a hand-built caller input.
 * @param current - the current binding table, or undefined when absent.
 * @param added - bindings this commit adds.
 * @returns true when every added binding is new or unchanged.
 */
function bindingsAppendable(
  current: ReadonlyMap<EventId, BlobId> | undefined,
  added: ReadonlyMap<EventId, BlobId>,
): boolean {
  for (const [eventId, blobId] of added) {
    const prior = current?.get(eventId)
    if (prior !== undefined && prior !== blobId) return false
  }
  return true
}

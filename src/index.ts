/**
 * Core types and storage interfaces for the B+Tree + EventId session format.
 * This package is intentionally pure: it owns the durable vocabulary and the
 * backend seam, not a Cordis service implementation.
 * @module @deepseek-ai/dsh-session-format
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { EventId } from './event-id.ts'

// The product already owns the SessionId, CompactionId, and CommandId brands;
// this package re-exports them so the durable format shares one identity
// vocabulary with the rest of the harness instead of declaring colliding
// duplicates. EventId is owned locally (event-id.ts) because the upstream
// session spine in the npm release does not carry it yet.
export type { SessionId } from '@deepseek-ai/dsh-session'
export type { CommandId } from '@deepseek-ai/dsh-commands/brand'
export type { EventId } from './event-id.ts'
export type { CompactionId } from '@deepseek-ai/dsh-compaction'

/** Logical blob identity; resolved through the blob mapping table. */
export type BlobId = Branded<'BlobId'>

/** Logical B+Tree page identity; pages are immutable and Copy-on-Write. */
export type PageId = Branded<'PageId'>

/**
 * Revision token compared by the storage CAS. The engine parses the `rev-<n>`
 * form to require strictly advancing commits; the repository validates the
 * format on registration.
 */
export type SessionRevision = Branded<'SessionRevision'>

/** Physical location of one blob in a per-session file or shared store. */
export interface BlobLocation {
  readonly segment: number
  readonly offset: number
  readonly length: number
}

/** Durable mapping from a logical blob id to its physical location. */
export interface BlobMapping {
  readonly blobId: BlobId
  readonly location: BlobLocation
}

/** One row of the separate reference table. */
export interface ReferenceRecord {
  readonly fromEventId: EventId
  readonly refName: string
  readonly toEventIds: readonly EventId[]
}

/** One rolling backup snapshot committed together with the session record. */
export interface StoredSessionBackup {
  readonly rootPage: PageId
  readonly referencesPage?: PageId
  readonly blobMapPage?: PageId
  readonly compactedPage?: PageId
  readonly seedBoundaryId?: EventId
}

/** Durable session record persisted as one atomic CAS unit. */
export interface StoredSessionRecord {
  readonly sessionId: SessionId
  readonly formatVersion: number
  /** Epoch milliseconds the session was created, when the source carried it. */
  readonly createdAt?: number
  /** Working directory captured by a legacy header, when the source carried it. */
  readonly cwd?: string
  /** Parent session identity captured by a legacy header, when the source carried it. */
  readonly parentSession?: SessionId
  /** Origin marker captured by a legacy header, when the source carried it. */
  readonly origin?: 'subagent'
  /** Delegation depth captured by a legacy header, when the source carried it. */
  readonly delegationDepth?: number
  /** Agent preset captured by a legacy header, when the source carried it. */
  readonly agentPreset?: string
  readonly rootPage: PageId
  readonly revision: SessionRevision
  /** Next EventId counter value; committed atomically so appends after a
   * restart never reuse an EventId shadowed by compaction or backup rotation. */
  readonly nextEventCounter: number
  readonly seedBoundaryId?: EventId
  readonly blobMapPage?: PageId
  readonly referencesPage?: PageId
  readonly compactedPage?: PageId
  /** High-water blob id allocated by the repository, persisted so a blob id
   * dropped by a compaction is never reused for different bytes. */
  readonly blobIdWatermark?: number
  /** Every EventId the session ever minted, bound to the blob it first pointed
   * at; the map only grows, so a CAS update cannot rebind a retired EventId to
   * different content even after every backup holding it has rotated out. */
  readonly usedEventBindings?: ReadonlyMap<EventId, BlobId>
  readonly backups: readonly StoredSessionBackup[]
}

/** A compaction summary payload recorded in the durable log, derived from the
 * `compaction/summary` event payload with every seq reference replaced by an
 * EventId and the checkpoint id added.
 */
export type CompactionSummary = {
  readonly compactionId: CompactionId
  readonly checkpointEventId: EventId
  /** The transaction's start/summary/end marker entries, shadowed as one bracket. */
  readonly markerEventIds: {
    readonly startEventId: EventId
    readonly summaryEventId: EventId
    readonly endEventId: EventId
  }
  readonly shadowedRange: { readonly startId: EventId; readonly endId: EventId }
  readonly shadowedIds: readonly EventId[]
  /** Seq-based range recorded by the summary event, mirroring its payload. */
  readonly shadowedSeqRange: { readonly start: number; readonly end: number }
  /** Seq-based shadowed ids recorded by the summary event, mirroring its payload. */
  readonly shadowedSeqs: readonly number[]
  /** Completed summary content, mirroring the `compaction/summary` event payload. */
  readonly summary: readonly ContentBlock[]
  /** The command that requested the compaction, when event-carrying. */
  readonly sourceCommandId?: CommandId
  /** Tokens shadowed by the replacement, mirroring the event payload. */
  readonly shadowedTokenCount: number
  /** The provider route that wrote the summary. */
  readonly provider: string
  /** The model that wrote the summary. */
  readonly model: string
  /** The generation cap the summarize call sent, when one applied. */
  readonly maxTokens?: number
  /** Provider-reported token usage for the summarization request, when emitted. */
  readonly usage?: TokenUsage
} & (
  | {
    /** Complete provider output of the identified LLM call. */
    readonly rawOutput: readonly ContentBlock[]
    /** The summary came from one identifiable call through the LLM seam. */
    readonly llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    readonly rawOutput?: readonly ContentBlock[]
    /** An unmarked summary does not identify a call through the LLM seam. */
    readonly llmStreamCall?: never
  }
)

/** Session record payload for a first write; the backend mints the revision. */
export type NewStoredSessionRecord = Omit<StoredSessionRecord, 'revision' | 'sessionId'>

/**
 * Backend-neutral storage seam. Any backend that implements these operations
 * can host the tree, compaction, and fork logic unchanged; the per-session
 * self-contained file comes first, with a shared store as a later evolution
 * (see the Agent Note for the intended implementation order).
 *
 * Pages and blobs are immutable: one PageId or BlobId always resolves to
 * identical bytes, so a reader that holds the PageIds from one session record
 * reads a consistent snapshot even while commits rotate backups; GC only
 * reclaims pages unreachable from the current record and its retained backups.
 */
export interface SessionStorage {
  readonly name: string
  /**
   * Read one immutable page. The page blob never changes for a PageId, and
   * the sessionId selects the per-session file that owns it.
   * @param sessionId - session whose file holds the page.
   * @param pageId - immutable page identity.
   * @returns the page bytes.
   */
  readPage(sessionId: SessionId, pageId: PageId): Promise<Uint8Array>
  /**
   * Write one immutable page.
   * @param sessionId - session whose file receives the page.
   * @param page - page bytes.
   * @returns the assigned page identity.
   */
  writePage(sessionId: SessionId, page: Uint8Array): Promise<PageId>
  /**
   * Read one immutable blob.
   * @param sessionId - session whose file holds the blob.
   * @param blobId - immutable blob identity.
   * @returns the blob bytes.
   */
  readBlob(sessionId: SessionId, blobId: BlobId): Promise<Uint8Array>
  /**
   * Write one immutable blob.
   * @param sessionId - session whose file receives the blob.
   * @param blob - blob bytes.
   * @returns the assigned blob identity.
   */
  writeBlob(sessionId: SessionId, blob: Uint8Array): Promise<BlobId>
  readSessionRecord(sessionId: SessionId): Promise<StoredSessionRecord | undefined>
  /**
   * Create the first session record. Create-only: it fails when a record
   * already exists for the session, so existing records can only change
   * through the compare-and-swap commit.
   * @param sessionId - session whose record is created.
   * @param record - the initial record payload without a revision.
   * @returns the minted initial revision, the CAS token for later commits.
   */
  writeSessionRecord(sessionId: SessionId, record: NewStoredSessionRecord): Promise<SessionRevision>
  /**
   * Atomically replace the current session record when its revision still
   * equals `expectedRevision`. The record carries `sessionId`, `rootPage`,
   * `referencesPage`, and the `backups` snapshots together, so reference
   * redirection, root replacement, and backup retention land in one
   * compare-and-swap transaction. The backend mints a fresh revision on
   * success — any revision carried in `next` is a placeholder and is never
   * reused — and returns it; `undefined` means the expected revision lost and
   * nothing changed. `next.sessionId` is the single authoritative session
   * identity for the swap.
   * @param next - the complete next session record; its revision is overwritten.
   * @param expectedRevision - revision the record must still carry.
   * @returns the minted next revision, or undefined when the CAS lost.
   */
  commit(next: StoredSessionRecord, expectedRevision: SessionRevision): Promise<SessionRevision | undefined>
}

// Re-export the in-memory B+Tree and blob store so the published root surface
// includes them.
export { SessionTree } from './btree.ts'
export { BLOB_SEGMENT_SIZE, BlobStore } from './blob-store.ts'
export type { LeafEntry } from './btree.ts'

// Re-export the operation prototypes so the published root surface includes
// serialization, compaction, fork, and migration.
export { performCompaction } from './compaction.ts'
export type { CompactionInput } from './compaction.ts'
export {
  deserializeSessionFile,
  exportSessionFile,
  importSessionFile,
  readSessionFile,
  serializeSessionFile,
  treeFromFile,
  writeSessionFile,
} from './file.ts'
export type { SessionFile } from './file.ts'
export { forkSessionFile } from './fork.ts'
export { migrateLegacySession } from './migrate.ts'
export type { LegacyEvent, LegacySession, MigrationResult } from './migrate.ts'

// Re-export the durable file store so the published root surface includes it.
export {
  decodeSnapshot,
  encodeSnapshot,
  readSnapshotFile,
  writeFileAtomic,
  writeSnapshotFile,
} from './file-store.ts'

// Re-export the high-level composition so the published root surface is
// constructible: the repository and the engine/stores it wraps.
export { SessionFormatEngine } from './engine.ts'
export { PageStore } from './page-store.ts'
export { SessionRepository } from './repository.ts'
export type { NewSessionFile } from './repository.ts'
export { SessionStore } from './store.ts'
export { advanceProjection, projectionNeedsRebuild, projectionWatermarkShadowed } from './projection.ts'
export type { ProjectionState } from './projection.ts'

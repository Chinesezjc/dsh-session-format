---
description: "B+Tree + EventId session format types, storage interfaces, and prototype runtime implementations: checksummed pages, a page store, revision CAS, garbage collection, a high-level engine and session repository, and multi-page B+Tree persistence."


kind: "package-library"
---

# @deepseek-ai/dsh-session-format

English | [中文](README.zh.md)

## Summary

`dsh-session-format` owns the durable vocabulary for a session format that separates order from identity: a Copy-on-Write B+Tree maintains the event sequence, every event has a stable `EventId`, and references, forks, watermarks, and the public API use `EventId`. This package delivers the core types, the storage backend seam, the in-memory B+Tree prototype (`SessionTree` with append, rank, range-replace, and split), operation prototypes for file serialization, physical compaction, fork, export/import, and legacy migration, and prototype runtime implementations: checksummed pages, a page store, metadata pages, revision CAS, garbage collection, a high-level engine and `SessionRepository`, and multi-page B+Tree persistence.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package owns the durable vocabulary and the `SessionStorage` seam plus prototype runtime implementations (checksummed pages, a page store, metadata pages, revision CAS, garbage collection, a high-level engine, and multi-page B+Tree persistence); it registers no Cordis service. It defines the durable types, the `SessionStorage` seam, and the `SessionTree` prototype that a future persistence provider composes to restore a current logical session before deriving model history. The package root re-exports `BlobStore` and `BLOB_SEGMENT_SIZE` (the in-memory blob area of the format) plus the high-level composition — `SessionRepository`, `SessionFormatEngine`, `PageStore`, and `SessionStore` — so the repository is constructible from the packaged artifact, and the EventId projection watermark helpers `advanceProjection`, `projectionNeedsRebuild`, and `projectionWatermarkShadowed` with their `ProjectionState` type. `SessionRepository` is the high-level surface: it owns the read-modify-write transactions (append, compact, fork), assigns the system-generated `EventId`/`BlobId` pairs for appended events, and publishes new roots through the engine's revision compare-and-swap.

The design is recorded in the proposed Agent Note [`session-physical-compaction-btree-pointer`](../../../.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package currently contains:

- `src/index.ts` — durable vocabulary types, the `SessionStorage` seam, and the session record shapes.
- `src/btree.ts` — in-memory Copy-on-Write B+Tree and the `SessionTree` facade.
- `src/file.ts` — self-contained session file serialization with durable-boundary validation, persisted through the atomic file store.
- `src/file-store.ts` — atomic durable file writes and the checksummed snapshot container.
- `src/disk-page-store.ts` — durable page store: one checksummed page file per page under a directory, with a persisted next-id watermark and rebuild-from-directory resume.
- `src/disk-session-store.ts` — durable session store: one JSON record file per session, written atomically with the revision CAS and the used-revision ABA set, rebuilt by scanning the directory.
- `src/compaction.ts` — physical compaction transaction: explicit surface-event removal, reference redirect, and shadowed-blob reclamation.
- `src/projection.ts` — EventId watermark projection state, fold, and the one-shot shadowed-range rebuild check (the projection must be the pre-compaction state).
- `src/fork.ts` — fork by `EventId` with prefix-inherited blobs, references, and compaction summaries.
- `src/migrate.ts` — legacy seq-format migration prototype (version 0).
- `src/pages.ts` + `src/page-store.ts` — checksummed page containers and the page-addressed store.
- `src/multi-page.ts` — one-node-per-page B+Tree persistence with structural validation.
- `src/metadata.ts` — blob-map, reference, and compaction-summary metadata pages.
- `src/store.ts` — revision CAS with ABA protection and rolling backups.
- `src/gc.ts` — reachability-based page garbage collection.
- `src/repository.ts` — the high-level `SessionRepository` facade owning append/compact/fork transactions.
- `src/engine.ts` — the high-level engine tying tree, blob, reference, and summary persistence together.
- `src/blob-store.ts` — in-memory segmented blob store: 2MB segments, independent copies on read, logical delete retains space for a future GC pass.
- `src/invariant.ts` — the package-owned invariant companion (an explained empty installer).

The engine persists whole `SessionFile`s and `SessionRepository` owns the high-level transactions; a shared durable backend is deferred. The package entry re-exports the repository, engine, page store, and session store; the lower-level modules stay `./src/*` imports (see Known Limitations).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session physical compaction Agent Note](../../../.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.md)
- [Session persistence subsystem](../../../docs/subsystems/persistence.md)

## Model Experience

None, as the package ships durable types, a storage seam, and prototype runtime implementations; it registers no prompt, tool, or model-visible content of its own, and a future persistence provider owns any model-facing rendering.

#### KV Cache effect

No direct effect; cache behavior is owned by the persistence provider that consumes this format.

## Known Limitations and Deferred Work

- **In-memory prototype only** — the in-memory B+Tree is not yet backed by a single durable multi-page file format; `DiskPageStore` persists one page file per page instead.
- **Repository over in-memory stores** — `SessionRepository` composes the in-memory `PageStore`/`SessionStore` through `SessionFormatEngine`; wiring it to the durable `file-store.ts` snapshots is deferred. `DiskPageStore` and `DiskSessionStore` are drop-in compatible with the `PageStore`/`SessionStore` surfaces, so the engine and repository can run over disk-backed pages and records today; the durable `file-store.ts` snapshot container and the shared store backend remain deferred.
- **Append is O(log n) and commits incrementally** — `append` mints the EventId/BlobId from the persisted high-water marks (`nextEventCounter`, `blobIdWatermark`), copies only the rightmost tree path (O(depth) pages, via `appendEntryToTree`), appends one blob-map chain page (`saveBlobAppends`), extends the binding table in place, and writes the slimmed record (the binding table lives in an append-only per-session log), so the per-append cost stays constant as the session grows. Whole-snapshot operations — registration, compaction, fork, export/import, and direct `engine.commitSession` — still rewrite the full tree, blob map, and record, and reads (`loadSession`) assemble the full file and binding table, so those remain O(n). The disk engine's per-page atomic file writes (fsync per page) dominate the append constant; a shared single-file backend would cut them.
- **Low-level commit points derive advancing values** — direct `engine.commitSession`/`engine.compact` calls must supply a strictly advancing revision and a watermark that clears the file's own blob ids (both enforced at the commit point); the repository path always derives them, and the commit rejects a lowering counter or a watermark below the blob map instead of trusting the caller.
- **Storage contract is JSDoc-only** — page/blob immutability, create-only writes, and CAS-minted revisions are interface contracts; no backend implements them yet, and there is no revision-bound read handle that pins pages against concurrent GC.
- **Append trusts the EventId counter** — `append` skips the uniqueness scan (the system counter mints unique ids); `replaceRange` and `remove` retire removed ids in the live lineage, so a replacement can never reuse an id an older root (or a rolling backup) still resolves, while a direct `insert` is validated against the invariants instead.

- **No real version step** — `SESSION_FORMAT_VERSION` remains v0 and the migration registry is empty.
- **Per-session files first** — a shared store backend is a later evolution.
- **Content blocks validate known discriminants only** — `isContentBlock` enforces required fields for `text`/`reasoning`/`tool-call`; other block types pass on the string type tag alone.
- **Blob immutability is checked per retained generation** — the CAS update rejects a blob rewrite only against the current generation and the backups still retained; once the last backup holding a BlobId rotates out, the same id could carry different bytes, so a durable backend must mint non-reusable blob ids or keep its own used-blob fingerprint.
- **Session metadata fields mirror SessionHeader** — `parentSession` is a `SessionId` and `origin` is `'subagent'` when present; the migrated record carries these from the legacy header.
- **Seq-based replace ranges expire under dense renumbering** — `removeEntries` renumbers survivors densely, so a `shadowedSeqRange` recorded before a compaction no longer maps to the renumbered tree; seq-based replace ranges are recorded for audit mirroring only.
- **Reference inventory required** — plugin payload fields that are sequence references must be declared before physical compaction can safely rewrite them.
- **Checkpoint `sourceEventSeqs` requires coverage, not exact equality** — both the write and import sides demand that every seq in `shadowedSeqs` is cited, but a checkpoint may also cite extra earlier events that remain live. Core's `assertProvenance` enforces the same inclusion-only rule, so a superset file still restores; exact set equality is not checked and is deferred until a producer proves a tighter provenance.
- **`./btree` surface stays wide until the first provider lands** — the low-level primitives and node types are exported for this package's tests and the future persistence provider; the export surface will be narrowed to the provider's actual imports when it lands. The recallable-compaction proposal back-link is likewise deferred to that work.
- **Engine modules re-exported, page format stays source-tree** — the package entry re-exports `SessionRepository`, `SessionFormatEngine`, `PageStore`, and `SessionStore` (plus `BlobStore`/`BLOB_SEGMENT_SIZE`); the page format and lower-level modules remain `./src/*` imports until a provider pins them.
- **Windows snapshots are atomic but not directory-fsynced** — the rename is atomic, but without a directory fsync the replacement may not survive a crash before the metadata flush.
- **Windows replacements do not preserve a narrower protected DACL** — the temp file inherits the parent directory's DACL and the rename carries it onto the target; the production DACL-preserving replacement path lives in `dsh-fs-local`.

### Dev Note

None.

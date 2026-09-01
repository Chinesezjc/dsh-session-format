/**
 * Prototype durable file store: writes a checksummed snapshot to a random
 * same-directory temp file, fsyncs it, atomically renames it over the target,
 * and fsyncs the parent directory on POSIX so the replacement is
 * crash-durable. The snapshot container reuses the checksummed binary page
 * format with a fixed page id, so snapshots share the page container's
 * corruption detection instead of hand-rolling a third header.
 * @module @deepseek-ai/dsh-session-format/file-store
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomicDurable } from './atomic-write.ts'
import { decodePage, encodePage } from './pages.ts'
import type { PageId } from './index.ts'

/** Fixed page id marking the page container that holds one whole snapshot. */
const SNAPSHOT_PAGE_ID = 'snapshot' as PageId

/**
 * Write bytes atomically to a path with fsync durability, delegating to the
 * shared crash-durable writer in `@deepseek-ai/dsh-atomic-write`.
 * @param path - absolute target file path.
 * @param data - complete new file content.
 * @returns resolution after the replacement is crash-durable.
 */
export async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  await writeFileAtomicDurable(path, data, { mode: 0o600 })
}

/**
 * Encode a snapshot as a checksummed binary page with a fixed id.
 * @param payload - snapshot payload to wrap.
 * @returns the checksummed page-container bytes.
 */
export function encodeSnapshot(payload: Uint8Array): Uint8Array {
  return encodePage(SNAPSHOT_PAGE_ID, payload)
}

/**
 * Decode and verify a snapshot page, rejecting any other page id.
 * @param bytes - page-container bytes to decode.
 * @returns the verified snapshot payload.
 * @throws when the container is corrupt or does not carry the snapshot page id.
 */
export function decodeSnapshot(bytes: Uint8Array): Uint8Array {
  const page = decodePage(bytes)
  if (page.pageId !== SNAPSHOT_PAGE_ID) throw new Error('not a snapshot page')
  return page.payload
}

/**
 * Read and verify a snapshot from disk.
 * @param path - absolute snapshot file path.
 * @returns the verified snapshot payload.
 */
export async function readSnapshotFile(path: string): Promise<Uint8Array> {
  return decodeSnapshot(new Uint8Array(await readFile(path)))
}

/**
 * Write a snapshot to disk atomically.
 * @param path - absolute snapshot file path.
 * @param payload - snapshot payload to persist.
 * @returns resolution after the snapshot is crash-durable.
 */
export async function writeSnapshotFile(path: string, payload: Uint8Array): Promise<void> {
  await writeFileAtomic(path, encodeSnapshot(payload))
}

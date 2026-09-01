/**
 * Synchronous crash-durable atomic file writes shared by the disk-backed
 * stores. Sync counterpart of `writeFileAtomicDurable` in `./atomic-write.ts`:
 * the async version serves the package's async surfaces, this module serves
 * the synchronous `PageStore`/`SessionStore`-compatible stores.
 * @module @deepseek-ai/dsh-session-format/atomic-write-sync
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Block the current thread for a bounded duration; Node has no sync sleep API. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Replace the target after bounded retries for transient Windows interference. */
function renameAtomicTempSync(temp: string, filename: string): void {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      renameSync(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. Windows
 * cannot open a directory for sync, so it is skipped there; the rename itself
 * remains atomic on Windows.
 * @param path - directory to fsync.
 */
function fsyncDirectorySync(path: string): void {
  if (process.platform === 'win32') return
  const handle = openSync(path, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

/** Atomically replace a file with crash-durable semantics, synchronously: the
 * content is written to a fresh temp inode (exclusive create), fsynced,
 * renamed over the target, and the directory is fsynced.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param mode - permission bits for the replacement inode.
 */
export function writeFileAtomicDurableSync(filename: string, content: Uint8Array, mode: number): void {
  const temp = join(dirname(filename), `.${randomUUID()}.tmp`)
  try {
    const handle = openSync(temp, 'wx', mode)
    try {
      writeSync(handle, content)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameAtomicTempSync(temp, filename)
    fsyncDirectorySync(dirname(filename))
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

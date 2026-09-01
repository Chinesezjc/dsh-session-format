import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
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

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * fsync a POSIX directory so a just-renamed entry is crash-durable. Windows
 * cannot open a directory for sync, so it is skipped there; the rename itself
 * remains atomic on Windows.
 * @param path - directory to fsync.
 * @returns resolution after the directory is synced.
 */
export async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Atomically replace a file with crash-durable semantics: the content is
 * written to a fresh temp inode (exclusive create), fsynced, renamed over the
 * target, and the directory is fsynced. Extracted from
 * @deepseek-ai/dsh-atomic-write because the npm release does not carry it.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomicDurable(
  filename: string,
  content: string | Uint8Array,
  options: Pick<{ mode?: number }, 'mode'>,
): Promise<void> {
  const temp = join(dirname(filename), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', options.mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameAtomicTemp(temp, filename)
    await fsyncDirectory(dirname(filename))
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

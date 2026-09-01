/**
 * Durable page store: one checksummed page file per page under a directory,
 * with a persisted next-id watermark. The synchronous surface mirrors the
 * in-memory {@link PageStore} so the engine and repository can switch backends
 * without an async rewrite.
 * @module @deepseek-ai/dsh-session-format/disk-page-store
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicDurableSync } from './atomic-write-sync.ts'
import type { PageId } from './index.ts'
import { decodePage, encodePage } from './pages.ts'

const PAGES_DIR = 'pages'
const META_FILE = 'meta.json'
const PAGE_FILE_SUFFIX = '.page'

/** Parse the persisted watermark file into the next page id.
 * @param path - meta file path.
 * @returns the persisted next page id, or 0 when no meta file exists.
 */
function readWatermark(path: string): number {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 0
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`corrupt page watermark file ${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt page watermark file ${path}`)
  }
  const next = (parsed as { readonly nextPageId?: unknown }).nextPageId
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0) {
    throw new Error(`page watermark file ${path} must carry a non-negative safe-integer nextPageId`)
  }
  return next
}

/** Match a page file name and extract its numeric id.
 * @param name - page file basename.
 * @returns the numeric page id when the name is a canonical `page_<n>.page`, else undefined.
 */
function numericPageId(name: string): number | undefined {
  const match = /^page_(\d+)\.page$/.exec(name)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * A page-addressed store persisted as one checksummed page file per page under
 * a directory, with checksum verification on every read and a persisted
 * next-id watermark. Page ids never identify different bytes, so the watermark
 * is never lowered by {@link DiskPageStore.deletePage}: a page id freed by GC
 * stays retired even after the store is rebuilt. The same-duration durability
 * contract as the in-memory store's fsync write path applies to every
 * mutation; a crash can leave an orphan page file or an advanced watermark,
 * never a page whose bytes differ from what the writer produced.
 */
export class DiskPageStore {
  private readonly rootDir: string
  private readonly pagesDir: string
  private readonly metaPath: string
  private readonly ids = new Set<PageId>()
  private nextPageId: number

  /**
   * Open (or create) a page store rooted at `rootDir`. Existing page files are
   * scanned and every canonical page id is registered; the next-id watermark
   * is the greater of the persisted watermark and the scanned maximum plus
   * one, so a crash between a page write and its watermark update never reuses
   * the written page id.
   * @param rootDir - directory owning `pages/` and `meta.json`.
   */
  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.pagesDir = join(rootDir, PAGES_DIR)
    this.metaPath = join(rootDir, META_FILE)
    mkdirSync(this.pagesDir, { recursive: true })
    const persisted = readWatermark(this.metaPath)
    let maxFileId = -1
    for (const name of readdirSync(this.pagesDir)) {
      const numeric = numericPageId(name)
      if (numeric === undefined) {
        throw new Error(`unexpected file in page directory: ${name}`)
      }
      maxFileId = Math.max(maxFileId, numeric)
      this.ids.add(this.pageIdFor(numeric))
    }
    const resumed = Math.max(persisted, maxFileId + 1)
    if (!Number.isSafeInteger(resumed)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    this.nextPageId = resumed
  }

  /** Write a payload as a new immutable page and return its PageId.
   * The page file is written and fsynced atomically before the watermark is
   * advanced and persisted; a crash in between leaves the page file readable
   * and the next open resumes past it via the directory scan.
   * @param payload - page payload bytes.
   * @returns the page id of the written page.
   */
  writePage(payload: Uint8Array): PageId {
    if (!Number.isSafeInteger(this.nextPageId + 1)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    const pageId = this.pageIdFor(this.nextPageId)
    writeFileAtomicDurableSync(
      this.pagePath(pageId),
      encodePage(pageId, payload),
      0o600,
    )
    this.ids.add(pageId)
    this.nextPageId += 1
    writeFileAtomicDurableSync(
      this.metaPath,
      new TextEncoder().encode(JSON.stringify({ nextPageId: this.nextPageId })),
      0o600,
    )
    return pageId
  }

  /** Read and verify a page payload.
   * @param pageId - page id to read.
   * @returns an independent copy of the page payload; mutating it cannot corrupt the store.
   */
  readPage(pageId: PageId): Uint8Array {
    let encoded: Uint8Array
    try {
      encoded = new Uint8Array(readFileSync(this.pagePath(pageId)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new Error(`missing page ${pageId}`)
      }
      throw error
    }
    const decoded = decodePage(encoded)
    if (decoded.pageId !== pageId) throw new Error(`page id mismatch: expected ${pageId}, got ${decoded.pageId}`)
    // Uint8Array.from forces a copy even when readFileSync returns a Buffer,
    // whose slice() aliases the underlying memory.
    return Uint8Array.from(decoded.payload)
  }

  /** Number of pages currently registered.
   * @returns the registered page count.
   */
  get size(): number {
    return this.ids.size
  }

  /** Whether a page id is registered.
   * @param pageId - page id to test.
   * @returns true when the page id is registered.
   */
  has(pageId: PageId): boolean {
    return this.ids.has(pageId)
  }

  /** Delete a page file and retire its id. The watermark is not lowered, so a
   * rebuilt store never reissues a deleted page id.
   * @param pageId - page id to delete.
   */
  deletePage(pageId: PageId): void {
    rmSync(this.pagePath(pageId), { force: true })
    this.ids.delete(pageId)
  }

  /** All page ids currently registered, in numeric id order.
   * @returns the registered page ids in insertion (ascending id) order.
   */
  pageIds(): PageId[] {
    return [...this.ids]
  }

  private pageIdFor(numeric: number): PageId {
    return `page_${numeric}` as PageId
  }

  private pagePath(pageId: PageId): string {
    return join(this.pagesDir, `${pageId}${PAGE_FILE_SUFFIX}`)
  }

  /** Root directory owning the store's `pages/` and `meta.json`.
   * @returns the constructor-provided root directory.
   */
  get directory(): string {
    return this.rootDir
  }
}

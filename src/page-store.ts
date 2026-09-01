/**
 * In-memory page store using the checksummed binary page container.
 * This is the prototype for the future shared/per-session durable page store.
 * @module @deepseek-ai/dsh-session-format/page-store
 */

import type { PageId } from './index.ts'
import { decodePage, encodePage } from './pages.ts'


// In-process monotonic page id source. Page ids never identify different
// bytes, so they must not be reused even after a store is rebuilt from a
// garbage-collected backing map; the durable backend persists this watermark.
let globalPageCounter = 0

/**
 * A page-addressed store with checksum verification on every read.
 * The storage map is injectable so tests can simulate storage-level corruption
 * (bytes differing from what the writer produced) through the real read path.
 */
export class PageStore {
  private readonly pages: Map<PageId, Uint8Array>

  /**
   * @param pages - optional backing storage; a fresh map is used when omitted.
   */
  constructor(pages: Map<PageId, Uint8Array> = new Map()) {
    this.pages = pages
    // Resume the counter past any `page_<n>` ids already in the backing map
    // so a store reopened over existing storage never overwrites them, and
    // never go below the in-process high watermark so freed ids stay retired.
    let maxId = -1
    for (const pageId of pages.keys()) {
      const match = /^page_(\d+)$/.exec(pageId)
      if (match !== null) {
        const numeric = Number(match[1])
        if (!Number.isSafeInteger(numeric)) {
          throw new Error(`page id ${pageId} is not a safe integer`)
        }
        maxId = Math.max(maxId, numeric)
      }
    }
    const resumed = maxId + 1
    if (!Number.isSafeInteger(resumed)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    globalPageCounter = Math.max(globalPageCounter, resumed)
  }

  /** Write a payload as a new immutable page and return its PageId.
   * @param payload - page payload bytes.
   * @returns the page id of the written page.
   */
  writePage(payload: Uint8Array): PageId {
    if (!Number.isSafeInteger(globalPageCounter + 1)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    const pageId = `page_${globalPageCounter++}` as PageId
    this.pages.set(pageId, encodePage(pageId, payload))
    return pageId
  }

  /** Read and verify a page payload.
   * @param pageId - page id to read.
   * @returns an independent copy of the page payload; mutating it cannot corrupt the store.
   */
  readPage(pageId: PageId): Uint8Array {
    const encoded = this.pages.get(pageId)
    if (encoded === undefined) throw new Error(`missing page ${pageId}`)
    const decoded = decodePage(encoded)
    if (decoded.pageId !== pageId) throw new Error(`page id mismatch: expected ${pageId}, got ${decoded.pageId}`)
    // Uint8Array.from forces a copy even when the backing map holds a Buffer,
    // whose slice() aliases the underlying memory.
    return Uint8Array.from(decoded.payload)
  }

  /** Number of pages currently stored.
   * @returns the page count.
   */
  get size(): number {
    return this.pages.size
  }

  /** Whether a page id exists.
   * @param pageId - page id to test.
   * @returns true when the page id is stored.
   */
  has(pageId: PageId): boolean {
    return this.pages.has(pageId)
  }

  /** Delete a page if present.
   * @param pageId - page id to delete.
   */
  deletePage(pageId: PageId): void {
    this.pages.delete(pageId)
  }

  /** All page ids currently stored.
   * @returns the stored page ids in insertion order.
   */
  pageIds(): PageId[] {
    return [...this.pages.keys()]
  }
}

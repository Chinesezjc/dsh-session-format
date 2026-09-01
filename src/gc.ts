/**
 * Prototype garbage collector for the page store.
 * A page is retained when it is reachable from a session's record page
 * pointers (tree root, blob map, reference table, compaction summaries, or a
 * retained rolling backup generation) or transitively from a retained
 * multi-page tree root through its internal child references.
 * @module @deepseek-ai/dsh-session-format/gc
 */

import type { PageId, StoredSessionRecord } from './index.ts'
import type { PageStore } from './page-store.ts'

/** Page ids referenced by one page payload, for reachability traversal.
 * @param payload - decoded page payload bytes.
 * @returns the child page ids referenced by a multi-page internal tree node;
 * metadata, leaf, and single-page payloads reference no pages.
 */
function referencedPageIds(payload: Uint8Array): PageId[] {
  let parsed: unknown
  try {
    // Fatal decoding, matching the other durable boundaries (multi-page,
    // metadata, file): an invalid UTF-8 sequence in a checksum-valid page is
    // corruption, and replacing it with U+FFFD could misread a kind field as
    // childless and let the sweep delete referenced pages.
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
  } catch {
    // A reachable page whose payload is not JSON cannot be a known page type;
    // treating it as childless would let the sweep delete pages that page
    // references (a checksum-valid but corrupted root), so stop the collection
    // instead of silently losing recoverable data.
    throw new Error('gc cannot traverse a reachable page with a non-JSON payload')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    // A JSON scalar is not a tree node either; aborting keeps the sweep from
    // deleting pages a structurally damaged reachable page would reference.
    throw new Error('gc cannot traverse a reachable page with a non-JSON payload')
  }
  const node = parsed as { kind?: unknown; children?: unknown }
  if (node.kind === 'internal') {
    // An internal node must carry a children array of page ids; a
    // checksum-valid page declaring kind=internal without one is corrupted,
    // and treating it as childless would let the sweep delete its subtrees.
    if (!Array.isArray(node.children)
      || !node.children.every((child): child is PageId => typeof child === 'string')) {
      throw new Error('gc cannot traverse a reachable internal page without a string children array')
    }
    return node.children
  }
  if (node.kind === 'leaf' || node.kind === undefined) {
    // Leaf and metadata pages reference no child pages; a children field on
    // them means a corrupted page (for example an internal node whose kind
    // was damaged to 'leaf'), and treating it as childless would let the
    // sweep delete the pages it references.
    if (node.children !== undefined) {
      throw new Error(`gc cannot traverse a reachable ${node.kind === 'leaf' ? 'leaf' : 'metadata'} page carrying children`)
    }
    return []
  }
  // An unknown kind (possibly carrying a children array) is not a page type
  // the tree loader produces; treating it as childless would let the sweep
  // delete pages a corrupted reachable page would reference.
  throw new Error(`gc cannot traverse a reachable page with unknown kind ${typeof node.kind === 'string' ? node.kind : JSON.stringify(node.kind)}`)
}

/** Collect unreachable pages and return how many were removed.
 * @param store - page store to collect.
 * @param sessions - registered session records whose page pointers are roots.
 * @returns the number of pages removed.
 */
export function collectGarbage(store: PageStore, sessions: Iterable<StoredSessionRecord>): number {
  const reachable = new Set<PageId>()
  const visit = (pageId: PageId): void => {
    if (reachable.has(pageId)) return
    reachable.add(pageId)
    for (const child of referencedPageIds(store.readPage(pageId))) visit(child)
  }
  const visitRecord = (record: StoredSessionRecord): void => {
    visit(record.rootPage)
    if (record.blobMapPage !== undefined) visit(record.blobMapPage)
    if (record.referencesPage !== undefined) visit(record.referencesPage)
    if (record.compactedPage !== undefined) visit(record.compactedPage)
    for (const backup of record.backups) {
      visit(backup.rootPage)
      if (backup.blobMapPage !== undefined) visit(backup.blobMapPage)
      if (backup.referencesPage !== undefined) visit(backup.referencesPage)
      if (backup.compactedPage !== undefined) visit(backup.compactedPage)
    }
  }
  for (const session of sessions) visitRecord(session)
  let removed = 0
  for (const pageId of store.pageIds()) {
    if (!reachable.has(pageId)) {
      store.deletePage(pageId)
      removed += 1
    }
  }
  return removed
}

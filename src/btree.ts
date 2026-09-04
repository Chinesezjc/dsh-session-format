/**
 * In-memory Copy-on-Write B+Tree prototype for the session event sequence.
 * This is not the durable page format yet; it proves the order/rank/split and
 * range-replace operations used by compaction and fork.
 * @module @deepseek-ai/dsh-session-format/btree
 */

import type { BlobId, EventId } from './index.ts'

/** A leaf entry ordered by the internal order key. */
export interface LeafEntry {
  readonly order: number
  readonly eventId: EventId
  readonly blobId: BlobId
}

/** One internal B+Tree node: routing keys plus child nodes. */
export interface InternalNode {
  readonly kind: 'internal'
  /** Number of leaf entries in the subtree; makes rank/at navigation O(depth). */
  readonly size: number
  /** Largest order in the subtree; makes range tests in split/count O(1). */
  readonly maxOrder: number
  readonly keys: readonly number[]
  readonly children: readonly TreeNode[]
}

/** One B+Tree leaf node: a contiguous run of ordered entries. */
export interface LeafNode {
  readonly kind: 'leaf'
  /** Number of entries in the leaf. */
  readonly size: number
  /** Largest order in the leaf, or -Infinity for an empty leaf. */
  readonly maxOrder: number
  readonly entries: readonly LeafEntry[]
}

/** A tree root or subtree node: either an internal or a leaf node. */
export type TreeNode = InternalNode | LeafNode


// Fanout constants. The durable page format proposed in the Agent Note
// (.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.md)
// fixes 4 KB pages; 64 entries at roughly 60 bytes of JSON entry each land a
// full leaf near that size, so these constants stand in for the physical page
// the durable format commits.
export const MAX_ENTRIES = 64
export const MAX_KEYS = 64

function isLeaf(node: TreeNode): node is LeafNode {
  return node.kind === 'leaf'
}

/** Freeze one entry so no caller-owned or read-returned reference can mutate
 * an entry that lives inside the tree, breaking orders, routing keys, or the
 * used-id lineage. All construction entry points (fromEntries, insert,
 * append) route through this, so every internal entry is immutable. */
function frozenEntry(entry: LeafEntry): LeafEntry {
  return Object.freeze({ ...entry })
}

function makeLeaf(entries: readonly LeafEntry[]): LeafNode {
  // Copy and freeze the node, its array, and the entries, so a caller holding
  // a node returned by the public ./btree API cannot mutate an old tree in
  // place (e.g. entries.reverse(), entries = [...] or a changed routing key).
  const last = entries[entries.length - 1]
  return Object.freeze({
    kind: 'leaf',
    size: entries.length,
    maxOrder: last === undefined ? -Infinity : last.order,
    entries: Object.freeze(entries.map(frozenEntry)),
  })
}

function makeInternal(keys: readonly number[], children: readonly TreeNode[]): InternalNode {
  const lastChild = children[children.length - 1]
  return Object.freeze({
    kind: 'internal',
    size: children.reduce((sum, child) => sum + child.size, 0),
    // An internal node always holds at least one child.
    maxOrder: (lastChild === undefined ? -Infinity : lastChild.maxOrder),
    keys: Object.freeze([...keys]),
    children: Object.freeze([...children]),
  })
}

/** Flatten all leaf entries in tree order.
 * @param root - tree root, or undefined for an empty tree.
 * @returns all leaf entries in tree order.
 */
export function toArray(root: TreeNode | undefined): LeafEntry[] {
  if (root === undefined) return []
  if (isLeaf(root)) return [...root.entries]
  const out: LeafEntry[] = []
  for (const child of root.children) {
    for (const entry of toArray(child)) out.push(entry)
  }
  return out
}

/** Build a balanced B+Tree from a sorted entry array.
 * The entries are shallow-copied and frozen at the entry point, so later
 * mutation of a caller-owned entry object cannot change the constructed tree.
 * @param entries - entries sorted by order.
 * @returns the tree root, or undefined when entries is empty.
 */
export function fromEntries(entries: readonly LeafEntry[]): TreeNode | undefined {
  if (entries.length === 0) return undefined
  const seen = new Set<EventId>()
  let previousOrder = -Infinity
  for (const entry of entries) {
    if (seen.has(entry.eventId)) throw new Error(`duplicate EventId ${entry.eventId}`)
    seen.add(entry.eventId)
    if (!Number.isFinite(entry.order) || entry.order <= previousOrder) {
      throw new Error('fromEntries requires finite strictly increasing orders')
    }
    previousOrder = entry.order
  }
  const leaves: LeafNode[] = []
  for (let i = 0; i < entries.length; i += MAX_ENTRIES) {
    leaves.push(makeLeaf(entries.slice(i, i + MAX_ENTRIES)))
  }
  let level: TreeNode[] = leaves
  while (level.length > 1) {
    const parents: InternalNode[] = []
    let index = 0
    while (index < level.length) {
      // Each internal node holds between 2 and MAX_KEYS + 1 children (a
      // merged tail bucket can reach MAX_KEYS + 1); a bucket with a single
      // child would make an internal node with one child, which the invariant
      // (and the multi-page loader) rejects. When the tail bucket would hold
      // exactly one child, merge it into the previous one.
      const size = Math.min(MAX_KEYS, level.length - index)
      if (size === 1 && index > 0) {
        // A non-empty previous bucket and the tail entry are guaranteed here:
        // size is 1 only past the first bucket, and index < level.length.
        /* v8 ignore start -- guarded by the loop shape above. */
        const previous = parents[parents.length - 1]
        const tail = level[index]
        if (previous === undefined || tail === undefined) throw new Error('missing bucket')
        /* v8 ignore stop */
        parents[parents.length - 1] = makeInternal(
          [...previous.keys, firstOrder(tail)],
          [...previous.children, tail],
        )
        index += 1
        continue
      }
      const children = level.slice(index, index + size)
      const keys = children.slice(1).map(child => firstOrder(child))
      parents.push(makeInternal(keys, children))
      index += size
    }
    level = parents
  }
  return level[0]
}

function must<T>(value: T | undefined, message: string): T {
  /* v8 ignore next -- every caller passes a value guaranteed present by tree invariants. */
  if (value === undefined) throw new Error(message)
  return value
}

function firstOrder(node: TreeNode): number {
  return isLeaf(node)
    ? must(node.entries[0], 'empty leaf').order
    : firstOrder(must(node.children[0], 'empty internal'))
}

/** Return the leaf entry at the given dense rank (0-based), or undefined.
 * @param root - tree root, or undefined for an empty tree.
 * @param rank - dense rank to read.
 * @returns the leaf entry at rank, or undefined when out of range.
 */
export function at(root: TreeNode | undefined, rank: number): LeafEntry | undefined {
  if (root === undefined || rank < 0) return undefined
  if (isLeaf(root)) return root.entries[rank]
  for (const child of root.children) {
    if (rank < child.size) return at(child, rank)
    rank -= child.size
  }
  return undefined
}

/** Number of leaf entries in a subtree.
 * Each node carries its subtree size, so this is O(1).
 * @param node - tree node.
 * @returns the number of leaf entries in the subtree.
 */
export function leafCount(node: TreeNode): number {
  return node.size
}

/** Validate one insertion against the tree invariants.
 * @param root - current tree root, or undefined for an empty tree.
 * @param entry - candidate leaf entry.
 */
function validateInsert(root: TreeNode | undefined, entry: LeafEntry): void {
  if (!Number.isFinite(entry.order)) throw new Error('insert requires a finite order')
  for (const existing of toArray(root)) {
    if (existing.order === entry.order) throw new Error(`duplicate order ${entry.order}`)
    if (existing.eventId === entry.eventId) throw new Error(`duplicate EventId ${entry.eventId}`)
  }
}

/** Insert one entry into a copy-on-write B+Tree and return the new root.
 * Validates the entry against the tree invariants (finite, unique order and
 * EventId) and shallow-copies and freezes it, so later mutation of the
 * caller-owned entry cannot change the constructed tree; the scan is O(n), so
 * the append path uses the unchecked variant.
 * @param root - current tree root, or undefined for an empty tree.
 * @param entry - leaf entry to insert.
 * @returns the new tree root.
 */
export function insert(root: TreeNode | undefined, entry: LeafEntry): TreeNode {
  validateInsert(root, entry)
  return insertUnchecked(root, frozenEntry(entry))
}

/** Insert without re-validating; callers must already satisfy the invariants. */
function insertUnchecked(root: TreeNode | undefined, entry: LeafEntry): TreeNode {
  if (root === undefined) return makeLeaf([entry])
  const result = insertInto(root, entry)
  if (result.length === 1) return must(result[0], 'missing child')
  return makeInternal([firstOrder(must(result[1], 'missing split child'))], result)
}

function insertInto(node: TreeNode, entry: LeafEntry): TreeNode[] {
  if (isLeaf(node)) {
    const entries = [...node.entries, entry].sort((a, b) => a.order - b.order)
    if (entries.length <= MAX_ENTRIES) return [makeLeaf(entries)]
    return splitLeaf(entries)
  }
  const index = node.keys.findIndex(key => entry.order < key)
  const atIndex = index === -1 ? node.children.length - 1 : index
  const childResult = insertInto(must(node.children[atIndex], 'missing child'), entry)
  const children = [...node.children]
  const keys = [...node.keys]
  if (childResult.length === 1) {
    children[atIndex] = must(childResult[0], 'missing child')
    return [makeInternal(keys, children)]
  }
  const [left, right] = childResult as [TreeNode, TreeNode]
  children.splice(atIndex, 1, left, right)
  const promoted = firstOrder(right)
  const keyIndex = keys.findIndex(key => promoted < key)
  if (keyIndex === -1) keys.push(promoted)
  else keys.splice(keyIndex, 0, promoted)
  if (keys.length <= MAX_KEYS) return [makeInternal(keys, children)]
  return splitInternal(keys, children)
}

function splitLeaf(entries: readonly LeafEntry[]): [LeafNode, LeafNode] {
  const mid = Math.ceil(entries.length / 2)
  return [makeLeaf(entries.slice(0, mid)), makeLeaf(entries.slice(mid))]
}

function splitInternal(keys: readonly number[], children: readonly TreeNode[]): [InternalNode, InternalNode] {
  const mid = Math.ceil(keys.length / 2)
  return [
    makeInternal(keys.slice(0, mid), children.slice(0, mid + 1)),
    makeInternal(keys.slice(mid + 1), children.slice(mid + 1)),
  ]
}

/** Replace a contiguous order range with new entries, returning a new tree.
 * The result is renumbered to dense integer orders, so the tree stays ordered
 * regardless of the caller's entry orders, and repeated replacement of the
 * same interval cannot exhaust float precision or collide with neighbours.
 * @param root - current tree root, or undefined for an empty tree.
 * @param startOrder - first order to remove, inclusive.
 * @param endOrder - last order to remove, inclusive.
 * @param newEntries - replacement entries; their order fields are reassigned.
 * @returns the new tree root.
 */
export function replaceRange(
  root: TreeNode | undefined,
  startOrder: number,
  endOrder: number,
  newEntries: readonly LeafEntry[],
): TreeNode | undefined {
  if (!Number.isFinite(startOrder) || !Number.isFinite(endOrder)) {
    throw new Error('replaceRange requires finite order boundaries')
  }
  if (startOrder > endOrder) throw new Error('replaceRange requires startOrder <= endOrder')
  const original = toArray(root)
  const existingIds = new Set(original.map(entry => entry.eventId))
  for (const entry of newEntries) {
    // Reusing an EventId that exists anywhere in the tree (even inside the
    // removed range) would make the same identity point at a different blob
    // across backups and the current revision.
    if (existingIds.has(entry.eventId)) throw new Error(`replaceRange reuses existing EventId ${entry.eventId}`)
  }
  const entries = original.filter(entry => entry.order < startOrder || entry.order > endOrder)
  const insertAt = entries.findIndex(entry => entry.order > endOrder)
  const next = insertAt === -1 ? entries.length : insertAt
  entries.splice(next, 0, ...newEntries)
  // Renumber the whole tree to dense integer orders. Float interpolation
  // between surviving neighbours would let repeated replacement of one
  // interval exhaust IEEE-754 resolution and collide with the neighbours;
  // dense integers keep every replacement distinct and the tree ordered.
  return fromEntries(entries.map((entry, index) => ({ ...entry, order: index })))
}

/** Remove exactly the listed events, keeping every other entry.
 * Deletion is by explicit EventId, not by an order range, so log-only events
 * interspersed between surface events survive a compaction.
 * @param root - current tree root, or undefined for an empty tree.
 * @param eventIds - event identities to remove; each must be present.
 * @returns the new tree root, or undefined when nothing remains.
 */
export function removeEntries(root: TreeNode | undefined, eventIds: readonly EventId[]): TreeNode | undefined {
  const ids = new Set(eventIds)
  const entries = toArray(root)
  const found = entries.filter(entry => ids.has(entry.eventId))
  if (found.length !== ids.size) throw new Error('removeEntries references an unknown EventId')
  // Survivors keep their orders: the tree stays ordered with gaps, and the
  // only caller (compaction) renumbers densely itself, so renumbering here
  // was wasted work.
  return fromEntries(entries.filter(entry => !ids.has(entry.eventId)))
}

/** Locate one entry by its order key, returning the entry and the count of
 * entries that precede it (its dense rank). Walks the tree using each node's
 * size and maxOrder, so the walk is O(depth); the count is exact because
 * orders are unique and the tree is kept sorted.
 * @param node - tree root or subtree, or undefined for an empty tree.
 * @param order - order key to locate.
 * @returns the entry carrying the order (undefined when absent) and the
 * number of entries with a smaller order.
 */
function locateByOrder(
  node: TreeNode | undefined,
  order: number,
): { readonly entry: LeafEntry | undefined; readonly count: number } {
  if (node === undefined) return { entry: undefined, count: 0 }
  if (isLeaf(node)) {
    // The leaf is kept sorted; the first entry with order >= target marks the
    // count of smaller entries, and an exact match is the located entry.
    let count = 0
    for (const entry of node.entries) {
      if (entry.order < order) {
        count += 1
      } else if (entry.order === order) {
        return { entry, count }
      } else {
        break
      }
    }
    return { entry: undefined, count }
  }
  let count = 0
  for (const child of node.children) {
    if (child.maxOrder < order) {
      count += child.size
    } else {
      // The child's range covers the target (or the target is a gap before
      // it): descend into the first child whose maxOrder is not below it.
      const sub = locateByOrder(child, order)
      return { entry: sub.entry, count: count + sub.count }
    }
  }
  return { entry: undefined, count }
}

/** Build an internal node (or return a lone child directly) from a list of
 * equal-height children, deriving the routing keys from child first orders.
 * A single child is returned unwrapped so a split never creates a one-child
 * internal node, which the invariant and the page loader reject.
 * @param children - child nodes in order.
 * @returns the combined node, or undefined when empty.
 */
function combineChildren(children: readonly TreeNode[]): TreeNode | undefined {
  if (children.length === 0) return undefined
  if (children.length === 1) return children[0]
  const keys = children.slice(1).map(child => firstOrder(child))
  return makeInternal(keys, children)
}

/** Split a tree at a dense rank: the first `rank` entries stay in the left
 * tree, the rest in the right. Walks one root-to-leaf path and rewrites the
 * nodes on it, so the split is O(depth) page-object operations instead of
 * flattening and rebuilding the whole tree.
 * @param root - tree root, or undefined for an empty tree.
 * @param rank - number of entries for the left tree, between 0 and the size.
 * @returns the left and right tree roots.
 */
export function splitAtRank(
  root: TreeNode | undefined,
  rank: number,
): [TreeNode | undefined, TreeNode | undefined] {
  if (root === undefined) return [undefined, undefined]
  if (rank <= 0) return [undefined, root]
  if (rank >= root.size) return [root, undefined]
  return splitNodeAtRank(root, rank)
}

function splitNodeAtRank(node: TreeNode, rank: number): [TreeNode | undefined, TreeNode | undefined] {
  if (isLeaf(node)) {
    const left = node.entries.slice(0, rank)
    const right = node.entries.slice(rank)
    return [
      left.length === 0 ? undefined : makeLeaf(left),
      right.length === 0 ? undefined : makeLeaf(right),
    ]
  }
  const leftChildren: TreeNode[] = []
  const rightChildren: TreeNode[] = []
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (child === undefined) throw new Error('empty internal node')
    if (rank >= child.size) {
      leftChildren.push(child)
      rank -= child.size
      continue
    }
    const [left, right] = splitNodeAtRank(child, rank)
    if (left !== undefined) leftChildren.push(left)
    if (right !== undefined) rightChildren.push(right)
    for (const rest of node.children.slice(index + 1)) rightChildren.push(rest)
    return [combineChildren(leftChildren), combineChildren(rightChildren)]
  }
  return [combineChildren(leftChildren), combineChildren(rightChildren)]
}

/** Split the tree at an order boundary and return two independent trees.
 * The boundary is inclusive on the left: entries with `order <= atOrder` stay
 * in the left tree, so `atOrder` itself belongs to the left tree and the right
 * tree starts with the first entry after the boundary. Fork relies on this
 * contract to keep the requested `atEventId` in the child prefix.
 * @param root - current tree root, or undefined for an empty tree.
 * @param atOrder - boundary order; the left tree includes entries with order <= atOrder.
 * @returns the left and right tree roots.
 */
export function split(root: TreeNode | undefined, atOrder: number): [TreeNode | undefined, TreeNode | undefined] {
  if (!Number.isFinite(atOrder)) throw new Error('split requires a finite boundary order')
  const entries = toArray(root)
  const index = entries.findIndex(entry => entry.order > atOrder)
  const cut = index === -1 ? entries.length : index
  return [fromEntries(entries.slice(0, cut)), fromEntries(entries.slice(cut))]
}

/**
 * A small in-memory session tree facade over the Copy-on-Write B+Tree.
 * The tree itself is the source of truth; `rank()` and `replaceRange` scan it
 * linearly and `append` walks the rightmost leaf — prototype costs, not the
 * persistence design. The durable format will persist pages instead of this
 * object graph.
 *
 * The facade also carries the lineage's used EventIds: every id ever inserted
 * (live or removed) stays recorded, so `append` and `replaceRange` can reject
 * reusing an id that an earlier root, a rolling backup, or a fork sibling
 * still resolves — one identity must never point at two blobs. The set is
 * shared by reference across Copy-on-Write snapshots and fork siblings: it is
 * append-only (ids are never removed), so all snapshots of one lineage agree
 * on which ids are taken. Across a restart the persisted `nextEventCounter`
 * is the authoritative never-reuse mechanism (see `StoredSessionRecord`).
 */
export class SessionTree {
  private readonly root: TreeNode | undefined
  private readonly usedEventIds: Set<EventId>
  /** EventId to order key, shared by reference across snapshots and fork
   * siblings. It is append-only in the same sense as the used-id lineage:
   * orders are never rewritten in place (removal leaves gaps, compaction
   * builds a fresh tree with a fresh map), so an entry's order in this map is
   * always the order it was inserted with, and lookups stay O(1). */
  private readonly orderById: Map<EventId, number>

  private constructor(root: TreeNode | undefined, usedEventIds: Set<EventId>, orderById: Map<EventId, number>) {
    this.root = root
    this.usedEventIds = usedEventIds
    this.orderById = orderById
  }

  /** Create an empty session tree.
   * @returns an empty SessionTree.
   */
  static empty(): SessionTree {
    return new SessionTree(undefined, new Set(), new Map())
  }

  /** Build a tree from a sorted entry array.
   * @param entries - entries sorted by order.
   * @returns a SessionTree with the same entries.
   */
  static fromEntries(entries: readonly LeafEntry[]): SessionTree {
    const used = new Set<EventId>()
    const orderById = new Map<EventId, number>()
    for (const entry of entries) {
      used.add(entry.eventId)
      orderById.set(entry.eventId, entry.order)
    }
    return new SessionTree(fromEntries(entries), used, orderById)
  }

  /** Number of events in the tree. */
  get size(): number {
    return leafCount(this.root ?? makeLeaf([]))
  }

  /** Append a new event at the end of the current sequence.
   * @param eventId - stable event identity.
   * @param blobId - blob holding the event payload.
   * @returns the new SessionTree.
   */
  append(eventId: EventId, blobId: BlobId): SessionTree {
    // The order is minted above every existing order, so no order scan is
    // needed; the EventId must be new to the whole lineage (live or removed,
    // including fork siblings) — reusing one would make a single identity
    // resolve to two blobs. The O(1) set lookup keeps append O(log n).
    if (this.usedEventIds.has(eventId)) {
      throw new Error(`append reuses EventId ${eventId}`)
    }
    this.usedEventIds.add(eventId)
    // When the current max order is at or beyond the safe-integer ceiling,
    // renumber the tree to dense integers first so `maxOrder() + 1` always
    // strictly increases (the map is rebuilt from the renumbered entries).
    const maxOrder = this.maxOrder()
    const nextOrder = maxOrder + 1
    if (nextOrder <= maxOrder) {
      // IEEE-754 rounding can make maxOrder + 1 equal maxOrder (or a huge
      // negative max can round the same way); renumber to dense integers so
      // the appended order strictly increases.
      const dense = toArray(this.root).map((entry, index) => ({ ...entry, order: index }))
      const renumbered = fromEntries(dense)
      const freshMap = new Map(this.orderById)
      for (const entry of dense) freshMap.set(entry.eventId, entry.order)
      freshMap.set(eventId, dense.length)
      const next = new SessionTree(insertUnchecked(renumbered, frozenEntry({ order: dense.length, eventId, blobId })), this.usedEventIds, freshMap)
      return next
    }
    this.orderById.set(eventId, nextOrder)
    return new SessionTree(insertUnchecked(this.root, frozenEntry({ order: nextOrder, eventId, blobId })), this.usedEventIds, this.orderById)
  }

  /** Return the event at a dense rank, or undefined when out of range.
   * @param rank - dense rank to read.
   * @returns the leaf entry at rank, or undefined.
   */
  at(rank: number): LeafEntry | undefined {
    return at(this.root, rank)
  }

  /** Return the dense rank for an EventId, or undefined when absent.
   * @param eventId - stable event identity.
   * @returns the dense rank, or undefined.
   */
  rank(eventId: EventId): number | undefined {
    const order = this.orderById.get(eventId)
    if (order === undefined) return undefined
    const located = locateByOrder(this.root, order)
    // The map may still carry a removed or rewritten id; the tree walk
    // confirms the entry is live under the same identity.
    if (located.entry === undefined || located.entry.eventId !== eventId) return undefined
    return located.count
  }

  /** Physically replace a range selected by EventIds and return a new tree.
   * @param startId - first EventId of the range, inclusive.
   * @param endId - last EventId of the range, inclusive.
   * @param newEntries - replacement entries; orders are assigned automatically.
   * @returns the new SessionTree.
   */
  replaceRange(startId: EventId, endId: EventId, newEntries: readonly LeafEntry[]): SessionTree {
    const startOrder = this.findOrder(startId)
    const endOrder = this.findOrder(endId)
    if (startOrder === undefined || endOrder === undefined || startOrder > endOrder) {
      throw new Error('replaceRange requires two present EventIds in order')
    }
    // An EventId used anywhere in the lineage (live, removed, or held by a
    // fork sibling) is still reachable through older roots or rolling
    // backups, so reusing it would make one identity resolve to two blobs;
    // the module-level check only sees the current root, so the facade
    // validates against the lineage here.
    for (const entry of newEntries) {
      if (this.usedEventIds.has(entry.eventId)) {
        throw new Error(`replaceRange reuses EventId ${entry.eventId}`)
      }
    }
    // Build the replacement tree first: the shared used set is updated only
    // after the operation succeeds, so a failed replace never mutates the
    // lineage (Publish state only at its commit point). The range replace
    // renumbers densely, so the order map is rebuilt from the next tree.
    const nextRoot = replaceRange(this.root, startOrder, endOrder, newEntries)
    const nextMap = new Map<EventId, number>()
    for (const entry of toArray(nextRoot)) nextMap.set(entry.eventId, entry.order)
    const next = new SessionTree(nextRoot, this.usedEventIds, nextMap)
    const removedIds = toArray(this.root)
      .filter(entry => entry.order >= startOrder && entry.order <= endOrder)
      .map(entry => entry.eventId)
    for (const id of removedIds) this.usedEventIds.add(id)
    for (const entry of newEntries) this.usedEventIds.add(entry.eventId)
    return next
  }

  /** Remove exactly the listed events, keeping every other entry.
   * @param eventIds - event identities to remove; each must be present.
   * @returns the new SessionTree.
   */
  remove(eventIds: readonly EventId[]): SessionTree {
    // Validate before mutating the shared used set: a failed remove (unknown
    // id) must not mark ids used that were never inserted.
    const next = new SessionTree(removeEntries(this.root, eventIds), this.usedEventIds, this.orderById)
    for (const id of eventIds) this.usedEventIds.add(id)
    return next
  }

  /** Split at an EventId boundary; the boundary event stays in the left tree.
   * Both result trees share the same used-id lineage, so neither side can
   * later reuse an EventId the other side (or the shared history) resolves.
   * @param atEventId - boundary EventId, included in the left tree.
   * @returns the left and right SessionTrees.
   */
  split(atEventId: EventId): [SessionTree, SessionTree] {
    const order = this.orderById.get(atEventId)
    if (order === undefined) throw new Error('cannot split at an unknown EventId')
    const located = locateByOrder(this.root, order)
    if (located.entry === undefined || located.entry.eventId !== atEventId) {
      throw new Error('cannot split at an unknown EventId')
    }
    // The boundary event stays in the left tree: rank of the boundary + 1.
    const [left, right] = splitAtRank(this.root, located.count + 1)
    // Every live id is already in the shared lineage (append and remove
    // maintain it), so splitting needs no extra O(n) sweep of both sides.
    return [new SessionTree(left, this.usedEventIds, this.orderById), new SessionTree(right, this.usedEventIds, this.orderById)]
  }

  /** Order of one EventId, found by scanning the tree, or undefined when absent.
   * @param eventId - stable event identity.
   * @returns the order key of the event, or undefined.
   */
  private findOrder(eventId: EventId): number | undefined {
    return this.orderById.get(eventId)
  }

  /** All entries in tree order.
   * @returns the entries as an array.
   */
  entries(): LeafEntry[] {
    return toArray(this.root)
  }

  /** Highest order present, or -1 for an empty tree.
   * The tree is kept sorted, so the rightmost leaf's last entry holds the max;
   * walking it is O(depth) instead of flattening the whole tree per append.
   * @returns the largest order in the tree, or -1 when empty.
   */
  private maxOrder(): number {
    let node: TreeNode | undefined = this.root
    if (node === undefined) return -1
    while (!isLeaf(node)) {
      const children: readonly TreeNode[] = node.children
      const child: TreeNode | undefined = children[children.length - 1]
      /* v8 ignore next -- internal nodes always hold at least one child. */
      if (child === undefined) throw new Error('empty internal node')
      node = child
    }
    const entries: readonly LeafEntry[] = node.entries
    const last: LeafEntry | undefined = entries[entries.length - 1]
    /* v8 ignore next -- leaves always hold at least one entry. */
    if (last === undefined) throw new Error('empty leaf')
    return last.order
  }
}

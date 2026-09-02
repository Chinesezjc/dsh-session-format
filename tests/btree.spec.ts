import { describe, expect, it } from 'vitest'
import { SessionTree as RootSessionTree } from '../src/index.ts'
import {
  SessionTree,
  at,
  fromEntries,
  insert,
  leafCount,
  removeEntries,
  replaceRange,
  split,
  splitAtRank,
  toArray,
  type InternalNode,
  type LeafEntry,
  type LeafNode,
  type TreeNode,
} from '../src/btree.ts'
import type { BlobId, EventId } from '../src/index.ts'

function eventId(n: number): EventId {
  return `evt_sess_test_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

function entry(order: number, n: number): LeafEntry {
  return { order, eventId: eventId(n), blobId: blobId(n) }
}

function appended(count: number): SessionTree {
  let tree = SessionTree.empty()
  for (let i = 0; i < count; i++) tree = tree.append(eventId(i), blobId(i))
  return tree
}

function orders(tree: SessionTree): number[] {
  return tree.entries().map(e => e.order)
}

describe('SessionTree', () => {
  it('appends and reports dense ranks', () => {
    let tree = SessionTree.empty()
    for (let i = 0; i < 10; i++) tree = tree.append(eventId(i), blobId(i))
    expect(tree.size).toBe(10)
    expect(tree.rank(eventId(0))).toBe(0)
    expect(tree.rank(eventId(9))).toBe(9)
    expect(tree.at(4)?.eventId).toBe(eventId(4))
  })

  it('supports physical range replacement with reassigned orders', () => {
    let tree = appended(10)
    // The caller-supplied order is a placeholder; replaceRange reassigns orders
    // inside the freed interval, so the result stays monotonic.
    const checkpoint: LeafEntry = { order: 0, eventId: eventId(100), blobId: blobId(100) }
    tree = tree.replaceRange(eventId(2), eventId(5), [checkpoint])
    expect(tree.size).toBe(7)
    expect(tree.rank(eventId(100))).toBe(2)
    expect(tree.rank(eventId(6))).toBe(3)
    const seen = orders(tree)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })

  it('keeps prior trees unchanged after append (copy-on-write)', () => {
    const empty = SessionTree.empty()
    const first = empty.append(eventId(0), blobId(0))
    const second = first.append(eventId(1), blobId(1))
    expect(empty.size).toBe(0)
    expect(first.size).toBe(1)
    expect(second.size).toBe(2)
    expect(first.rank(eventId(0))).toBe(0)
    expect(first.rank(eventId(1))).toBeUndefined()
    expect(second.rank(eventId(1))).toBe(1)
  })

  it('keeps the original tree unchanged after range replacement (copy-on-write)', () => {
    const before = appended(10)
    const compacted = before.replaceRange(eventId(2), eventId(5), [entry(0, 100)])
    expect(before.size).toBe(10)
    expect(before.rank(eventId(3))).toBe(3)
    expect(compacted.rank(eventId(3))).toBeUndefined()
    expect(compacted.rank(eventId(100))).toBe(2)
  })

  it('keeps orders monotonic when re-compacting a previously replaced range', () => {
    let tree = appended(7)
    tree = tree.replaceRange(eventId(2), eventId(5), [entry(0, 100), entry(0, 101)])
    // Replacing just the first replacement entry keeps the whole tree ordered:
    // dense renumbering always places the new entries below the surviving right
    // neighbour.
    tree = tree.replaceRange(eventId(100), eventId(100), [entry(0, 102)])
    const seen = orders(tree)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(tree.size).toBe(5)
    expect(tree.rank(eventId(102))).toBe(2)
    expect(tree.rank(eventId(101))).toBe(3)
    expect(tree.rank(eventId(6))).toBe(4)
  })

  it('splits at an EventId boundary inclusively', () => {
    const tree = appended(8)
    const [left, right] = tree.split(eventId(3))
    expect(left.size).toBe(4)
    expect(right.size).toBe(4)
    expect(left.rank(eventId(2))).toBe(2)
    expect(left.rank(eventId(3))).toBe(3)
    expect(right.rank(eventId(4))).toBe(0)
    // The boundary stays in the left tree; the right tree excludes it.
    expect(right.rank(eventId(3))).toBeUndefined()
  })

  it('reports empty-tree facts without events', () => {
    const empty = SessionTree.empty()
    expect(empty.size).toBe(0)
    expect(empty.at(0)).toBeUndefined()
    expect(empty.at(-1)).toBeUndefined()
    expect(empty.rank(eventId(0))).toBeUndefined()
    expect(empty.entries()).toEqual([])
  })

  it('builds from a sorted entry array', () => {
    const tree = SessionTree.fromEntries([entry(0, 0), entry(1, 1), entry(2, 2)])
    expect(tree.size).toBe(3)
    expect(tree.rank(eventId(2))).toBe(2)
    expect(tree.at(1)?.eventId).toBe(eventId(1))
    expect(SessionTree.fromEntries([]).size).toBe(0)
  })

  it('reports undefined ranks for absent EventIds and out-of-range reads', () => {
    const tree = appended(8)
    expect(tree.rank(eventId(999))).toBeUndefined()
    expect(tree.at(-1)).toBeUndefined()
    expect(tree.at(8)).toBeUndefined()
    expect(tree.at(999)).toBeUndefined()
  })

  it('rejects an unknown replaceRange range', () => {
    const tree = appended(8)
    expect(() => tree.replaceRange(eventId(999), eventId(2), [entry(0, 100)])).toThrow(/two present EventIds in order/)
    expect(() => tree.replaceRange(eventId(2), eventId(999), [entry(0, 100)])).toThrow(/two present EventIds in order/)
    expect(() => tree.replaceRange(eventId(5), eventId(2), [entry(0, 100)])).toThrow(/two present EventIds in order/)
  })

  it('rejects an unknown split boundary', () => {
    const tree = appended(8)
    expect(() => tree.split(eventId(999))).toThrow(/cannot split at an unknown EventId/)
  })

  it('replaces a tail range and a single event, and deletes a range', () => {
    let tree = appended(10)
    tree = tree.replaceRange(eventId(7), eventId(9), [entry(0, 100)])
    expect(tree.size).toBe(8)
    expect(tree.rank(eventId(100))).toBe(7)
    expect(tree.rank(eventId(6))).toBe(6)
    expect(tree.at(7)?.eventId).toBe(eventId(100))

    tree = tree.replaceRange(eventId(4), eventId(4), [entry(0, 101), entry(0, 102)])
    expect(tree.size).toBe(9)
    expect(tree.rank(eventId(101))).toBe(4)
    expect(tree.rank(eventId(102))).toBe(5)
    expect(tree.rank(eventId(100))).toBe(8)
    expect(tree.at(6)?.eventId).toBe(eventId(5))

    tree = tree.replaceRange(eventId(0), eventId(2), [])
    expect(tree.size).toBe(6)
    expect(tree.rank(eventId(101))).toBe(1)
    expect(tree.rank(eventId(100))).toBe(5)
  })
})

describe('B+Tree primitives', () => {
  it('handles empty roots', () => {
    expect(toArray(undefined)).toEqual([])
    expect(fromEntries([])).toBeUndefined()
    expect(at(undefined, 0)).toBeUndefined()
    expect(split(undefined, 5)).toEqual([undefined, undefined])
    expect(insert(undefined, entry(0, 0))).toBeDefined()
  })

  it('splits at a boundary beyond every order and reads every leaf entry', () => {
    const root = fromEntries(Array.from({ length: 5 }, (_, i) => entry(i, i)))
    const [left, right] = split(root, 999)
    expect(left).toBeDefined()
    expect(right).toBeUndefined()
    expect(toArray(left).map(e => e.order)).toEqual([0, 1, 2, 3, 4])
    expect(at(root, 4)?.eventId).toBe(eventId(4))
    expect(at(root, 5)).toBeUndefined()
  })

  it('grows across two internal levels and splits an overflowing internal node', () => {
    const root = fromEntries(Array.from({ length: 25 }, (_, i) => entry(i, i)))
    // Two inserts into different leaves of the same full 4-child parent: the
    // first leaf split adds a key, the second overflows the parent's keys.
    const grown = insert(insert(root, entry(1.5, 100)), entry(6.5, 101))
    const flat = toArray(grown)
    expect(flat).toHaveLength(27)
    const seen = flat.map(e => e.order)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(leafCount(grown)).toBe(27)
    expect(at(grown, 26)?.eventId).toBe(eventId(24))
    expect(at(grown, 27)).toBeUndefined()
  })

  it('replaces a module-level range and keeps the result ordered', () => {
    const root = fromEntries(Array.from({ length: 10 }, (_, i) => entry(i, i)))
    const replaced = replaceRange(root, 2, 5, [entry(0, 100), entry(0, 101)])
    const seen = toArray(replaced).map(e => e.order)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    // The result is renumbered to dense integer orders in tree order.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(toArray(replaced).map(e => e.eventId)).toEqual([
      eventId(0), eventId(1), eventId(100), eventId(101), eventId(6), eventId(7), eventId(8), eventId(9),
    ])
  })

  it('keeps every replacement order distinct under repeated nested replacement', () => {
    // Replacing the first of the previous round's replacement entries again
    // repeatedly halves the gap to its successor; float interpolation would
    // collide after ~50 rounds, dense renumbering never does.
    let tree = SessionTree.fromEntries([entry(0, 0), entry(1, 1), entry(2, 2), entry(3, 3)])
    for (let round = 0; round < 100; round++) {
      const targetId = tree.at(tree.size - 2)?.eventId
      expect(targetId).toBeDefined()
      tree = tree.replaceRange(targetId as EventId, targetId as EventId, [
        entry(0, 100 + round * 2),
        entry(0, 101 + round * 2),
      ])
      const seen = orders(tree)
      expect(seen.length).toBe(new Set(seen).size)
      expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    }
  })

  it('re-exports SessionTree from the root entry', () => {
    expect(RootSessionTree).toBe(SessionTree)
  })

  it('renumbers before appending when the max order hits the safe-integer ceiling', () => {
    const huge = Number.MAX_SAFE_INTEGER
    const tree = SessionTree.fromEntries([entry(huge - 1, 0), entry(huge, 1)])
    const grown = tree.append(eventId(2), blobId(2))
    const seen = orders(grown)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(grown.rank(eventId(2))).toBe(2)
    expect(grown.at(2)?.eventId).toBe(eventId(2))
  })

  it('renumbers before appending when a huge negative max order rounds', () => {
    // At -Number.MAX_VALUE the ulp is far larger than 1, so +1 rounds back to
    // the same value; the append must renumber instead of duplicating the order.
    const tree = SessionTree.fromEntries([entry(-Number.MAX_VALUE, 0)])
    const grown = tree.append(eventId(1), blobId(1))
    const seen = orders(grown)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(grown.rank(eventId(1))).toBe(1)
  })

  it('copies and freezes caller-owned entries so later mutation cannot change the tree', () => {
    // fromEntries must shallow-copy AND freeze each entry: mutating a mutable
    // caller-owned object in place afterwards must not rewrite the tree's
    // order or identity, and no read exit may hand out a mutable entry.
    const middle = { order: 1, eventId: eventId(1), blobId: blobId(1) }
    const root = fromEntries([entry(0, 0), middle, entry(2, 2)])
    middle.order = 99
    middle.eventId = eventId(999)
    const flat = toArray(root)
    expect(flat.map(e => e.order)).toEqual([0, 1, 2])
    expect(flat.map(e => e.eventId)).toEqual([eventId(0), eventId(1), eventId(2)])

    // insert must copy and freeze the caller's entry the same way.
    const inserted = { order: 3, eventId: eventId(3), blobId: blobId(3) }
    const grown = insert(root, inserted)
    inserted.order = 999
    inserted.eventId = eventId(998)
    const grownFlat = toArray(grown)
    expect(grownFlat[3]?.order).toBe(3)
    expect(grownFlat[3]?.eventId).toBe(eventId(3))

    // Read exits return the frozen internal entries: mutating one in place
    // must not corrupt the tree. In strict mode an assignment to a frozen
    // object throws, which is the loud failure this contract wants.
    const tree = SessionTree.fromEntries([entry(0, 0), entry(1, 1)])
    const read = tree.at(1) as LeafEntry
    expect(Object.isFrozen(read)).toBe(true)
    expect(() => {
      ;(read as { order: number }).order = 99
    }).toThrow()
    expect(tree.rank(eventId(1))).toBe(1)
    expect(tree.at(1)?.order).toBe(1)
  })

  it('freezes the node arrays a public ./btree caller can reach', () => {
    // The module-level API returns nodes whose node object, entries/keys/
    // children arrays are frozen: reversing an entries array, replacing a
    // field wholesale, or mutating a routing key in place must not rewrite
    // the old tree.
    const leafRoot = fromEntries([entry(0, 0), entry(1, 1), entry(2, 2)]) as LeafNode
    expect(Object.isFrozen(leafRoot)).toBe(true)
    expect(Object.isFrozen(leafRoot.entries)).toBe(true)
    expect(Object.isFrozen(leafRoot.entries[0])).toBe(true)
    expect(() => {
      ;(leafRoot.entries as LeafEntry[]).reverse()
    }).toThrow()
    expect(() => {
      ;(leafRoot as unknown as { entries: LeafEntry[] }).entries = []
    }).toThrow()

    // An internal root exposes frozen keys and children arrays too.
    const grown = insert(insert(fromEntries(Array.from({ length: 5 }, (_, i) => entry(i, i))), entry(1.5, 100)), entry(6.5, 101))
    const internalRoot = grown as InternalNode
    expect(Object.isFrozen(internalRoot)).toBe(true)
    expect(Object.isFrozen(internalRoot.keys)).toBe(true)
    expect(Object.isFrozen(internalRoot.children)).toBe(true)
    expect(() => {
      ;(internalRoot.keys as number[]).reverse()
    }).toThrow()
    expect(() => {
      ;(internalRoot.children as TreeNode[]).pop()
    }).toThrow()
    expect(() => {
      ;(internalRoot as unknown as { keys: number[] }).keys = []
    }).toThrow()
    // The tree still reads correctly after the failed mutations.
    expect(toArray(grown)).toHaveLength(7)
  })

  it('rejects replacement entries that reuse an existing EventId', () => {
    const tree = appended(5)
    expect(() => tree.replaceRange(eventId(1), eventId(3), [entry(0, 100), entry(0, 4)])).toThrow(/reuses EventId/)
    // Reusing an EventId inside the removed range is rejected too: the old
    // identity must not point at a different blob across backups.
    expect(() => tree.replaceRange(eventId(1), eventId(3), [entry(0, 2)])).toThrow(/reuses EventId/)
    // The module-level primitive validates against the current root.
    const root = fromEntries([entry(0, 0), entry(1, 1), entry(2, 2)])
    expect(() => replaceRange(root, 0, 1, [entry(0, 0)])).toThrow(/reuses existing EventId/)
  })

  it('rejects reusing any EventId the lineage already used (live, removed, or sibling)', () => {
    // After a range replacement the removed EventIds are retired; a later
    // replacement must not resurrect one, because the older root (and any
    // rolling backup of it) still resolves that id to the old blob.
    let tree = appended(8)
    tree = tree.replaceRange(eventId(2), eventId(5), [entry(0, 100)])
    expect(() => tree.replaceRange(eventId(6), eventId(7), [entry(0, 3)])).toThrow(/reuses EventId/)
    // remove() retires its ids the same way.
    tree = tree.remove([eventId(100)])
    expect(() => tree.replaceRange(eventId(0), eventId(0), [entry(0, 100)])).toThrow(/reuses EventId/)
    // append() rejects a removed EventId too: the id may still resolve through
    // a rolling backup, so one identity must not point at two blobs.
    expect(() => tree.append(eventId(2), blobId(200))).toThrow(/reuses EventId/)
    // append() rejects a live EventId as well — no asymmetric trust split.
    expect(() => tree.append(eventId(0), blobId(201))).toThrow(/reuses EventId/)
    // An old Copy-on-Write snapshot shares the lineage: it must reject an id
    // a descendant later used.
    const snapshot = appended(4)
    const grown = snapshot.append(eventId(10), blobId(10))
    expect(grown.rank(eventId(10))).toBe(4)
    expect(() => snapshot.append(eventId(10), blobId(11))).toThrow(/reuses EventId/)
    // The used lineage survives a split on both sides.
    const [left, right] = tree.split(eventId(1))
    expect(() => left.replaceRange(eventId(0), eventId(0), [entry(0, 2)])).toThrow(/reuses EventId/)
    expect(() => right.replaceRange(eventId(6), eventId(6), [entry(0, 100)])).toThrow(/reuses EventId/)
    // Each side also rejects the other side's ids: one identity must never
    // point at two blobs across the forked trees.
    expect(() => left.replaceRange(eventId(0), eventId(0), [entry(0, 6)])).toThrow(/reuses EventId/)
    expect(() => right.replaceRange(eventId(6), eventId(6), [entry(0, 1)])).toThrow(/reuses EventId/)
    // append() rejects a sibling's ids after a split as well.
    expect(() => left.append(eventId(6), blobId(300))).toThrow(/reuses EventId/)
    expect(() => right.append(eventId(1), blobId(301))).toThrow(/reuses EventId/)
    // fromEntries seeds the used set with the entries' own ids.
    const built = SessionTree.fromEntries([entry(0, 0), entry(1, 1)])
    expect(() => built.append(eventId(0), blobId(500))).toThrow(/reuses EventId/)
    // A replaceRange that introduces a new EventId records it in the lineage:
    // appending that id afterwards must be rejected even without a remove.
    let replaced = appended(4)
    replaced = replaced.replaceRange(eventId(1), eventId(2), [entry(0, 100)])
    expect(() => replaced.append(eventId(100), blobId(501))).toThrow(/reuses EventId/)
    // A failed remove must not pollute the shared used set: the unknown id
    // stays appendable afterwards.
    const clean = appended(3)
    expect(() => clean.remove([eventId(999)])).toThrow(/unknown EventId/)
    expect(clean.append(eventId(999), blobId(502)).rank(eventId(999))).toBe(3)
  })

  it('rejects duplicate EventIds when building a tree', () => {
    expect(() => SessionTree.fromEntries([entry(0, 0), entry(1, 0)])).toThrow(/duplicate EventId/)
    expect(() => fromEntries([entry(0, 0), entry(1, 0)])).toThrow(/duplicate EventId/)
    expect(() => fromEntries([entry(1, 0), entry(1, 1), entry(2, 2)])).toThrow(/strictly increasing/)
    expect(() => fromEntries([entry(0, 0), entry(2, 1), entry(1, 2)])).toThrow(/strictly increasing/)
    expect(() => fromEntries([entry(Number.NaN, 0)])).toThrow(/strictly increasing/)
    const root = fromEntries([entry(0, 0), entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4)])
    expect(() => replaceRange(root, 1, 2, [entry(0, 3)])).toThrow(/reuses existing EventId/)
  })

  it('rejects an inverted or non-finite module-level range', () => {
    const root = fromEntries([entry(0, 0), entry(1, 1), entry(2, 2)])
    expect(() => replaceRange(root, 3, 1, [])).toThrow(/startOrder <= endOrder/)
    expect(() => replaceRange(root, Number.NaN, Number.NaN, [])).toThrow(/finite order boundaries/)
    expect(() => split(root, Number.NaN)).toThrow(/finite boundary order/)
  })

  it('validates direct insertions against the tree invariants', () => {
    const root = fromEntries([entry(0, 0), entry(1, 1), entry(2, 2)])
    expect(() => insert(root, entry(1, 3))).toThrow(/duplicate order/)
    expect(() => insert(root, entry(3, 0))).toThrow(/duplicate EventId/)
    expect(() => insert(root, entry(Number.NaN, 3))).toThrow(/finite order/)
  })

  it('removes exactly the listed events and keeps the rest', () => {
    let tree = appended(7)
    tree = tree.remove([eventId(2), eventId(4)])
    expect(tree.size).toBe(5)
    expect(tree.rank(eventId(2))).toBeUndefined()
    expect(tree.rank(eventId(4))).toBeUndefined()
    expect(tree.rank(eventId(1))).toBe(1)
    expect(tree.rank(eventId(5))).toBe(3)
    // Survivors keep their orders (gaps allowed): the dense rank is separate
    // from the sparse order, and compaction renumbers when it rebuilds.
    expect(orders(tree)).toEqual([0, 1, 3, 5, 6])

    const root = fromEntries(Array.from({ length: 5 }, (_, i) => entry(i, i)))
    const remaining = removeEntries(root, [eventId(0), eventId(4)])
    expect(toArray(remaining).map(e => e.eventId)).toEqual([eventId(1), eventId(2), eventId(3)])
    expect(() => tree.remove([eventId(999)])).toThrow(/unknown EventId/)
    expect(() => removeEntries(root, [eventId(1), eventId(999)])).toThrow(/unknown EventId/)
    expect(removeEntries(root, [eventId(0), eventId(1), eventId(2), eventId(3), eventId(4)])).toBeUndefined()
  })
})

describe('logarithmic navigation', () => {
  it('splits a deep tree at a rank without flattening or one-child nodes', () => {
    let tree = SessionTree.empty()
    for (let i = 0; i < 30; i++) tree = tree.append(eventId(i), blobId(i))
    const root = fromEntries(tree.entries())
    for (const rank of [1, 15, 29]) {
      const [left, right] = splitAtRank(root, rank)
      const leftEntries = toArray(left)
      expect(leftEntries).toHaveLength(rank)
      expect(toArray(right)).toHaveLength(30 - rank)
      expect(leftEntries.map(e => e.eventId)).toEqual(Array.from({ length: rank }, (_, i) => eventId(i)))
      const check = (n: TreeNode | undefined): void => {
        if (n === undefined) return
        if (n.kind === 'internal') {
          expect(n.children.length).toBeGreaterThanOrEqual(2)
          expect(n.size).toBe(n.children.reduce((a, c) => a + c.size, 0))
          expect(n.maxOrder).toBe(n.children[n.children.length - 1]!.maxOrder)
          for (const child of n.children) check(child)
        }
      }
      check(left)
      check(right)
    }
  })

  it('keeps ranks dense across sparse orders after removal', () => {
    let tree = SessionTree.empty()
    for (let i = 0; i < 30; i++) tree = tree.append(eventId(i), blobId(i))
    tree = tree.remove([eventId(3), eventId(20)])
    expect(tree.rank(eventId(3))).toBeUndefined()
    expect(tree.rank(eventId(4))).toBe(3)
    expect(tree.rank(eventId(29))).toBe(27)
    const [left, right] = tree.split(eventId(15))
    // Boundary 15 stays in the left tree; removed 3/20 are gone.
    expect(left.size + right.size).toBe(28)
    expect(left.rank(eventId(15))).toBe(14)
    expect(left.rank(eventId(3))).toBeUndefined()
    expect(right.rank(eventId(16))).toBe(0)
  })

  it('locates entries across leaf boundaries by rank', () => {
    let tree = SessionTree.empty()
    for (let i = 0; i < 12; i++) tree = tree.append(eventId(i), blobId(i))
    expect(tree.rank(eventId(0))).toBe(0)
    expect(tree.rank(eventId(7))).toBe(7)
    expect(tree.rank(eventId(11))).toBe(11)
    expect(tree.at(0)?.eventId).toBe(eventId(0))
    expect(tree.at(11)?.eventId).toBe(eventId(11))
  })
})

# Trees, Tries, and Balanced Indexes

**Industry names:** binary search tree · self-balancing tree (AVL / red-black) ·
B-tree / B+tree · trie (prefix tree) · skip list. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

Verdict first: buffr's own TypeScript builds **no** tree. But trees are running
*underneath* it on every query — Postgres uses a **B-tree** for the `app_id`
index and the primary-key lookup, and the HNSW vector index (file 05) is a
**layered, skip-list-like** structure that's tree-adjacent. This file teaches
the tree family, marks what's exercised (B-tree, implicitly, in Postgres) vs
`not yet exercised` (BST, trie, balanced trees in buffr's code), and anchors to
the `BinarySearchTree.ts` you built by hand.

```
  Zoom out — where trees run (mostly below buffr)

  ┌─ buffr TS layer ──────────────────────────────────────────┐
  │  no tree built here — ids in a flat Map / Set              │
  └──────────────────────────┬─────────────────────────────────┘
                             │  queries hit
  ┌─ pgvector / Postgres ────▼─────────────────────────────────┐
  │  ★ B-tree ★  chunks_app_id index   (sql/001:33)            │ ← we are here
  │  ★ B-tree ★  primary-key on chunks.id                       │
  │  HNSW layered graph (tree-adjacent skip structure)          │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a **tree** is a hierarchy where each node has children, giving you
O(log n) navigation *if it stays balanced*. A **BST** orders nodes left-smaller /
right-larger so search halves the space each step. A **B-tree** is the
disk-friendly, high-fanout balanced tree every database index is built on. A
**trie** indexes by *prefix* — the structure for autocomplete and "all ids
starting with X". The repo runs the first three under the hood and exercises the
trie not at all.

---

## The structure pass

**Layers** — the tree family by what they're for:

```
  the tree family — one shape, different jobs

  ┌─ BST ────────────────────────────────┐  ordered lookup, O(log n) if balanced
  └──────────────────┬─────────────────────┘
   ┌─ balanced BST (AVL/red-black) ─────┐   guarantees the balance → O(log n)
   └──────────────────┬──────────────────┘
    ┌─ B-tree / B+tree ────────────────┐    balanced + high fanout for DISK
    └──────────────────┬─────────────────┘    ← Postgres indexes
     ┌─ trie ─────────────────────────┐       indexed by PREFIX, not by value
     └────────────────────────────────┘        ← autocomplete, not in buffr
```

**Axis — guarantees.** Trace "is O(log n) guaranteed?": a plain BST promises it
only if inserts arrive randomly (sorted inserts degrade it to a O(n) linked
list); a *balanced* BST and a B-tree *guarantee* it by rebalancing on insert.
That guarantee is the entire reason databases use B-trees, not naive BSTs.

**Seam — the balance boundary.** Between "BST that can degrade to a line" and
"B-tree that can't" is the load-bearing seam. You felt this building
`BinarySearchTree.ts`: insert 1,2,3,4,5 in order and your tree is a linked list,
O(n) search. The balanced version refuses to degrade. Postgres lives on the safe
side of that seam so query plans stay predictable.

---

## How it works

### Move 1 — the mental model

You built the BST: `insert`, `search`, `delete` (recursive and iterative), all
three traversals, successor/predecessor. The mental model is "binary search made
into a structure" — every node splits the remaining space in half.

```
  BST — left < node < right, so search halves each step

              [50]                 search for 30:
             /    \                 30 < 50 → go left
          [30]    [70]              30 = 30 → found, 2 hops not 5
         /   \    /   \             O(log n) IF balanced
      [20]  [40][60] [80]

  the catch: insert 10,20,30,40,50 in order →
      [10]-[20]-[30]-[40]-[50]   a linked list, O(n)   ← degenerate BST
```

A B-tree is this idea hardened for disk: instead of one key per node it packs
*many* keys per node (a whole disk page), so the tree is wide and shallow — a
million rows in 3–4 hops. That high fanout is why it's the database index, not
the binary BST.

### Move 2 — what's actually running, and what isn't

**Exercised (under buffr): the B-tree index.** Two B-trees serve every buffr
query, both declared in one schema file:

```sql
-- sql/001_agents_schema.sql:33 — a B-tree index (Postgres default)
create index if not exists chunks_app_id on agents.chunks (app_id);
-- and the implicit B-tree behind the primary key:
--   id text primary key   → B-tree on chunks.id
```

Walk what the B-tree does for the search query (`pg-vector-store.ts:70-77`):

```
  the WHERE filter rides a B-tree; the ORDER BY rides HNSW

  select ... from agents.chunks
  where app_id = $2          ── B-tree lookup on chunks_app_id (sql/001:33)
  order by embedding <=> $1  ── HNSW graph walk (file 05), NOT the B-tree
  limit $3
```

The annotation that matters: **two different index structures serve one query**.
The `where app_id` filter is a B-tree range/equality lookup — O(log n), the BST
idea you built, just disk-shaped. The `order by <=>` is the HNSW graph. A
B-tree could never answer "nearest vector" (there's no 1-D order on 768-dim
points to binary-search) — which is exactly why a second, graph index exists.
That's the cleanest illustration in the repo of "pick the index for the query
shape."

**Not yet exercised: the BST in buffr's own code.** buffr keeps ids in a flat
`Set`/`Map` (file 02), not a BST. A BST would matter the day you needed *ordered*
iteration or range queries over ids in-process ("all chunks between id X and Y")
— a hash map can't do that, an ordered tree can. You've built the structure; the
repo just doesn't have the requirement yet.

**Not yet exercised: the trie.** A trie indexes by prefix — share the common
front of keys down a path, branch where they diverge.

```
  trie — indexed by prefix (the structure buffr lacks)

  insert "memory:c1:1", "memory:c1:2", "doc#0"

        (root)
        /     \
     "m"      "d"
      │        │
   "emory:c1:"  "oc#0"
      /    \
    "1"    "2"

  query "all ids starting with memory:c1" → walk to that node, O(prefix len)
```

This is *almost* relevant: buffr's memory ids are `"memory:<conv>:<n>"`
(`context.md`, `session.ts:53`) — a perfectly prefix-structured key space. If you
ever needed "fetch every memory chunk for conversation c1" by id prefix rather
than by vector similarity, a trie (or Postgres `LIKE 'memory:c1:%'`, which uses a
B-tree prefix scan) is the structure. Today that recall goes through vector
search instead, so the trie is a clean `not yet exercised` — and a real gap,
since you haven't built one in reincodes either.

### Move 3 — the principle

Trees buy you O(log n) ordered navigation, but only if balance is guaranteed —
which is why databases use B-trees (balance + disk fanout), not the textbook
BST. The repo's lesson is index-selection: a B-tree answers `where app_id =`, a
graph answers `order by <vector distance>`, and no single structure does both.

---

## Primary diagram

The tree family mapped onto buffr — what runs, what doesn't.

```
  trees in buffr — exercised vs gap

  EXERCISED (in Postgres, below buffr's code):
   ┌ B-tree on chunks.id (PK)        ── O(log n) id lookup
   └ B-tree on app_id (sql/001:33)   ── the WHERE filter

  REINCODES (built by hand, not in buffr):
   └ BinarySearchTree.ts             ── insert/search/delete, all traversals

  NOT YET EXERCISED (neither buffr nor reincodes):
   ┌ self-balancing BST (AVL/red-black) ── the guarantee under the B-tree
   └ trie / prefix tree                  ── memory ids are prefix-shaped ★ gap
```

---

## Elaborate

The progression BST → balanced BST → B-tree is one of the cleanest "same idea,
hardened for reality" stories in DSA. The BST is the clean concept; AVL/red-black
trees add the rebalancing that makes O(log n) a *guarantee* not a hope; the
B-tree adds high fanout so each node is a disk page and the tree is shallow
enough that a billion rows is 4 hops. Postgres' B-tree is the one you use every
day without seeing it. The trie is the odd cousin — it indexes by position in the
key rather than by comparison, which makes it unbeatable for prefix queries
(autocomplete, IP routing tables, dictionary lookups) and useless for "nearest
value". The database-systems guide owns the B-tree-as-storage view; this guide
owns the algorithmic shape.

---

## Interview defense

**Q: The query filters `where app_id` and orders by vector distance. Why can't
one index serve both?**

```
  B-tree: orders keys on ONE comparable dimension → great for app_id =
          768-dim vectors have no single sort order → useless for nearest
  HNSW:   graph of "who's near whom" in 768-d space → great for nearest
          can't answer app_id = without scanning → useless for the filter
```

A B-tree needs a total order on one dimension; vectors live in 768 dimensions
with no such order, so "nearest" isn't a range query. HNSW is built for exactly
that and can't do equality filtering. So Postgres uses both — B-tree for the
`where`, HNSW for the `order by` (`sql/001:30-33`). Naming "two index shapes,
two query shapes" is the answer.

**Q: When does a BST degrade, and what fixes it?**

```
  insert sorted 1,2,3,4,5 → right-leaning chain → O(n) search (a linked list)
  fix: self-balancing (AVL rotations / red-black recoloring) → forced O(log n)
       or B-tree: rebalances on split, stays shallow on disk
```

A plain BST degrades to O(n) on sorted input — it becomes a linked list. That's
the bug your hand-built `BinarySearchTree.ts` has and a balanced tree doesn't.
Databases never ship the naive version precisely because real insert order isn't
random. Naming the degenerate case is the signal you built one.

**Anchor:** "B-tree for ordered/range/equality on one dimension; a graph index
for nearest-neighbor in many dimensions — the repo runs both because no single
tree does both."

---

## See also

- `05-graphs-and-traversals.md` — HNSW, the graph that answers what the B-tree
  can't
- `02-arrays-strings-and-hash-maps.md` — the hash map (O(1) membership) vs the
  tree (O(log n) ordered) tradeoff
- `06-sorting-searching-and-selection.md` — binary search, the BST idea without
  the tree
- Cross-link: `.aipe/study-database-systems/` — the B-tree as a storage engine
  structure

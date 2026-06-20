# Trees, Tries, and Balanced Indexes

**BST / B-tree / trie / balanced search structures** — *Industry standard*

## Zoom out, then zoom in

Trees in this repo are all *implicit* — you never write one, but two are doing
load-bearing work under the SQL. Every primary key is a B-tree; the HNSW index is
a tree-of-graphs. Your `BinarySearchTree.ts` is the hand-built cousin of both.

```
  Zoom out — the trees you don't see, by layer

  ┌─ buffr source layer ─────────────────────────────────┐
  │  (no tree written in TypeScript anywhere)             │ ← gap
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ pgvector / Postgres layer▼──────────────────────────┐
  │  PRIMARY KEY (id text)  → B-TREE index  ★             │ ← balanced,
  │  chunks_app_id index    → B-TREE                       │   on-disk
  │  HNSW index             → layered graph (tree-ish)     │   (see file 05)
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ your reincodes (anchor) ─▼──────────────────────────┐
  │  BinarySearchTree.ts → the UNBALANCED hand-built BST  │ ← what you own
  └───────────────────────────────────────────────────────┘
```

Zoom in: a **binary search tree** keeps left < node < right, giving `O(log n)`
search *if balanced* and `O(n)` if it degenerates into a list. A **B-tree** is
the self-balancing, disk-friendly generalization Postgres uses for every index.
A **trie** keys on string *prefixes* — absent here entirely. The question this
file answers: *which ordered structures hold buffr's lookups up, and which famous
ones does it never touch?*

## The structure pass

Trace **one axis — "how does a lookup narrow the search space?" — down the
levels.**

```
  Axis = "given a key, how fast do I find the row?"

  ┌─ array scan (no index) ────────────────┐
  │ check every row → O(n)                  │  no narrowing
  └──────────────────────┬──────────────────┘
                         │  seam: add a balanced index
  ┌─ B-tree on PK ────────▼────────────────┐
  │ halve the space each node → O(log n)    │  ordered narrowing
  └──────────────────────┬──────────────────┘
                         │  seam: exact key vs nearest neighbor
  ┌─ HNSW on embedding ───▼────────────────┐
  │ greedy descent through layers → ~O(log n)│  proximity narrowing
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between the B-tree (which answers *exact* key lookups
— `where id = 'work.md#3'`) and HNSW (which answers *nearest* lookups — `order by
embedding <=> query`). Both narrow `O(log n)`, but a B-tree narrows by *ordered
comparison* and HNSW by *proximity in a graph*. The axis (how narrowing happens)
flips at that boundary — which is why Postgres needs two completely different
index types on the same table.

## How it works

### Move 1 — the mental model

You built the BST. `BinarySearchTree.ts` in reincodes — insert, search, delete
(recursive and iterative), all three traversals, successor/predecessor. A balanced
index is that same idea with one fix: it never lets one side get taller than the
other, so search stays `O(log n)` instead of degrading to `O(n)`.

```
  BST search — halve the space at each node (the kernel)

  looking for 7:
                  8
                ╱   ╲
              4       12
             ╱ ╲     ╱
            2   6   10
                 ╲
                  7        path: 8 → 4 → 6 → 7   (3 hops for 7 nodes)
  ──────────────────────────────────────────────────
  each comparison discards HALF the remaining tree → O(log n) IF balanced
```

The single sentence: **an ordered tree turns search into repeated halving — but
only a *balanced* one keeps the halving honest.** A B-tree is the
production-grade balanced tree; your BST is the teaching version that can
degenerate.

### Move 2 — the structures, balanced and not

**The unbalanced BST — what you built, and its failure mode.**
Your `BinarySearchTree.ts` inserts by walking left/right until it finds the slot.
Bridge: it's the structure your call-stack visualizers animate. Where it breaks:
insert sorted data (1, 2, 3, 4, 5) and every node goes right — the tree becomes a
linked list and search degrades to `O(n)`. That degeneration is *the* reason
balanced trees exist.

```
  BST degeneration — the failure a B-tree fixes

  insert 1,2,3,4,5 in order:        balanced ideal:
    1                                     3
     ╲                                  ╱   ╲
      2                                2     4
       ╲          O(n) — a list!     ╱       ╲
        3                           1         5
         ╲                          └─ stays O(log n)
          4
           ╲
            5
```

**The B-tree — every Postgres primary key.**
`agents.chunks.id` is `text primary key`. Postgres builds a B-tree index on it
automatically. Bridge: it's your BST, but each node holds *many* keys (not one)
and the tree self-balances on every insert, so it never degenerates and stays
shallow even at millions of rows — which keeps disk reads (the real cost) to a
handful. Where it breaks: without it, `where id = ...` and the `on conflict (id)`
upsert would both be sequential scans — `O(n)` per chunk written.

```
  B-tree — many keys per node, always balanced, disk-shaped

  ┌─────────[ m | t ]─────────┐          ← root: 2 keys, 3 children
  ▼            ▼              ▼
 [a|c|f]    [n|q|r]       [u|x|z]         ← leaves hold the actual rows
  │
  └─ each node = one disk page; a 3-level B-tree indexes millions of rows
     because fan-out is huge. on conflict (id) uses THIS for O(log n) upsert
```

**The HNSW index — a tree-of-graphs (the bridge to file 05).**
HNSW stacks layers: a sparse top layer for long jumps, denser layers below for
fine-grained proximity. The descent through layers is tree-like (coarse → fine),
but each layer is a *graph*, not an ordered tree. Bridge: think of it as a B-tree's
"narrow the space each level" idea applied to proximity instead of order. The full
walk lives in `05`; here, note only that it's the third index structure on this
one table, and it's the *non-ordered* one.

```
  HNSW as a layered descent — tree-shaped narrowing, graph at each level

  layer 2 (sparse)   o─────────────o          ← big jumps, few nodes
                     │              │
  layer 1 (denser)   o──o────o──────o          ← medium hops
                     │  │    │
  layer 0 (all)      o─o─o─o─o─o─o─o─o          ← every chunk, fine steps
                          ▲
                    descend coarse→fine, like a B-tree's levels (file 05)
```

### Move 3 — the principle

**Ordered search wants a *balanced* tree; the balance is the whole game.** An
unbalanced BST and a balanced B-tree have the same idea and wildly different
worst cases. Postgres hands you the balanced version for free on every index —
which is exactly why this repo never hand-writes a tree, and why building the
unbalanced one (as you did) is the right way to *understand* what the database
is doing for you.

## Primary diagram

The three tree-shaped structures across the system, balanced vs not.

```
  Tree structures in the system — recap

  STRUCTURE        WHERE                 BALANCED?   COST      WHO WRITES IT
  ───────────────────────────────────────────────────────────────────────
  BST              reincodes BinarySearchTree.ts   NO (can degrade) O(log n)~O(n)  you
  B-tree           every PK / index (agents.*)     YES              O(log n)       Postgres
  HNSW (layered)   chunks_embedding_hnsw           YES-ish          ~O(log n)      pgvector
  trie             — nowhere —                      —                —             nobody
```

## Implementation in codebase

**Use cases.** The B-tree is reached for on every `on conflict (id) do update`
upsert (it finds the existing row in `O(log n)`) and every `where app_id = $2`
filter. The HNSW tree-of-graphs is reached for on every similarity `search`.

```
  sql/001_agents_schema.sql  (lines 14–30) — the indexes that ARE trees

  create table if not exists agents.chunks (
    id text primary key,              ← B-TREE index, automatic, for exact
                                         id lookup + the upsert's conflict check
    ...
    embedding vector(768) not null,
    ...
  );
  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
       │                    │
       │                    └─ the layered-graph index (file 05) — NOT a B-tree;
       │                       ordered comparison can't rank proximity
       └─ HNSW is a separate index type because "nearest" isn't "ordered"

  create index if not exists chunks_app_id on agents.chunks (app_id);
       │
       └─ a second B-tree, so where app_id = 'laptop' narrows O(log n)
          instead of scanning every chunk
```

The upsert that *uses* the PK B-tree:

```
  src/pg-vector-store.ts  (lines 47–56) — on conflict rides the B-tree

  `insert into agents.chunks (id, ...) values ($1, ...)
   on conflict (id) do update set ...`
                  │
                  └─ "does a row with this id exist?" is an O(log n) B-tree
                     lookup, not an O(n) scan. Without the PK index this
                     upsert would scan the whole table per chunk indexed.
```

## Elaborate

The B-tree is Bayer & McCreight, 1972 — designed explicitly for disk: wide nodes
(one node = one disk page) minimize the number of slow disk seeks, which is why
databases use B-trees and not the binary BSTs from algorithm class. Your
`BinarySearchTree.ts` is the conceptual ancestor; the leap to B-tree is "make
nodes wide and self-balancing so the tree stays shallow on disk." The storage
mechanics of *that* — page layout, fill factor, splits — belong to
`study-database-systems`.

`not yet exercised`, and worth naming bluntly:
- **Tries.** Prefix search (autocomplete, IP routing, `LIKE 'foo%'` acceleration)
  appears nowhere in buffr, and `me.md` flags it as absent from your portfolio
  too. This is a genuine gap — a trie is a distinct mental model (branch per
  character, not per comparison) and worth a deliberate build.
- **Self-balancing rotations (AVL / red-black).** You built the *unbalanced* BST;
  you've never implemented the rotation logic that keeps it balanced. The B-tree
  hides this from you in Postgres. Building red-black insert is the natural next
  step from your BST.
- **Segment trees / Fenwick trees.** Range-query structures — absent here and in
  your portfolio.

## Interview defense

**Q: Postgres gives you a B-tree on every primary key. Why does this table
*also* need a separate HNSW index?**

```
  two index types, two questions

  B-tree   "id = 'work.md#3'?"      ordered comparison → O(log n)
  HNSW     "closest to [768 floats]?" proximity in a graph → ~O(log n)
            ▲
            └─ ordered comparison can't answer "nearest" — no total
               order on cosine distance that a B-tree could exploit
```

Answer: "A B-tree narrows by ordered comparison — perfect for exact id lookup
and the upsert's conflict check. But 'nearest in 768-dim cosine space' has no
useful total order to compare against, so a B-tree can't help. HNSW narrows by
proximity through a layered graph instead. Same table, two questions, two index
structures." Anchor: `sql/001_agents_schema.sql:14` (PK) vs `:28` (HNSW).

**Q: Your reincodes BST can degrade to `O(n)`. How does Postgres avoid that?**

Answer: "Self-balancing. My `BinarySearchTree.ts` has no rotation logic, so
inserting sorted keys turns it into a linked list — `O(n)` search. Postgres uses
a B-tree, which rebalances on every insert via node splits, so it stays shallow
regardless of insert order. The balancing is the whole difference between my
teaching BST and a production index." Anchor: `BinarySearchTree.ts` vs the PK
B-tree.

## Validate

1. **Reconstruct.** Draw a BST degenerating into a list from sorted inserts, and
   name the property a B-tree enforces to prevent it (balance via splits).
2. **Explain.** Why does `on conflict (id)` in `src/pg-vector-store.ts:48` need
   the PK B-tree to be `O(log n)`?
3. **Apply.** You want prefix search over chunk text (`autocomplete`). Which
   structure, and is it present anywhere in buffr? (A trie — absent; a real gap.)
4. **Defend.** Argue why buffr correctly never hand-writes a tree in TypeScript,
   even though you've built one (`BinarySearchTree.ts`). (Postgres provides
   balanced trees for free; hand-rolling would be reinventing the index.)

## See also

- `05-graphs-and-traversals.md` — HNSW's layered graph walked in full.
- `02-arrays-strings-and-hash-maps.md` — the `Map` alternative to a tree for
  `O(1)` unordered lookup.
- `06-sorting-searching-and-selection.md` — binary search, the array analog of a
  BST.
- `study-database-systems` → B-tree page layout, splits, and on-disk index
  mechanics.

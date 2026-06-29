# Trees, Tries & Balanced Indexes

**Industry name(s):** binary search tree (BST) · self-balancing tree (B-tree /
red-black) · trie (prefix tree) — *Industry standard*

The leading nouns: **balanced index** (the structure that keeps lookups
O(log n) as data grows), **trie** (prefix tree for string lookup), **BST**
(the ordered-tree primitive you already built). buffr exercises tree
*structures* only **indirectly** — through Postgres's indexes — and **tries
are not exercised at all**, which makes this the honest-gap file.

---

## Zoom out — where trees live (mostly hidden)

buffr has no hand-written tree. But it leans on two tree-shaped indexes inside
Postgres, and it pointedly *lacks* a third (the trie). The zoom-out marks all
three.

```
  Zoom out — trees in and around buffr

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  no BST, no trie, no balanced tree in TypeScript           │ ← we are here
  └───────────────────────────┬────────────────────────────────┘
                              │ every query / upsert hits indexes
  ┌─ Postgres indexes ────────▼────────────────────────────────┐
  │  primary key on chunks.id   → B-tree (balanced)            │
  │  chunks_app_id index        → B-tree (balanced)            │  sql/001:30
  │  ★ HNSW vector index ★      → graph, NOT a tree (file 05)  │  sql/001:28
  └───────────────────────────┬────────────────────────────────┘
                              │ NOT present anywhere:
  ┌─ trie (prefix tree) ──────▼────────────────────────────────┐
  │  would power autocomplete / prefix search over doc text     │
  │  NOT YET EXERCISED — and absent from your portfolio too     │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"how does a lookup stay O(log n) as rows grow, and
which structures buy that?"** You built the answer's prototype — a
`BinarySearchTree` with insert/search/delete and all three traversals. This
file maps that prototype to the *balanced* trees Postgres actually uses, and
flags the trie as the real gap.

---

## Structure pass — layers, axis, seams

**Axis: lookup cost as data grows — does it stay O(log n)?** Trace it; the
seam is *balance*, the property your hand-built BST didn't guarantee but a
B-tree does.

```
  Axis: "does lookup stay O(log n) as n grows?" — across trees

  ┌─ plain BST (your BinarySearchTree.ts) ──┐
  │  O(log n) IF balanced...                 │   → but inserts can skew it
  │  worst case (sorted inserts): O(n) chain │
  └───────────────┬─────────────────────────┘
      seam: who guarantees balance?   (THIS flip is why DBs use B-trees)
      ┌───────────▼──────────────────────────┐
      │ B-tree (Postgres PK / app_id index)   │   → self-rebalances on every
      │  O(log n) GUARANTEED, wide fan-out     │     insert; stays shallow
      └───────────────┬───────────────────────┘
      seam: keys are strings with shared prefixes?  (trie territory)
          ┌──────────▼───────────────────────┐
          │ trie — O(length), shares prefixes  │   → NOT in buffr
          └────────────────────────────────────┘
```

The load-bearing seam: a plain BST is O(log n) only *if* it stays balanced,
and nothing forces it to — sorted inserts degrade it to a linked list. A
**B-tree** self-rebalances on every insert, so it's O(log n) *guaranteed*.
That guarantee is exactly why every database index, including buffr's primary
key, is a B-tree and not the BST you built.

---

## How it works

### Move 1 — the mental model

You built the unbalanced version. Your `BinarySearchTree.ts` is the kernel:
every left descendant is smaller, every right is larger, so search walks down
halving the candidates each step. A **balanced** tree is that same shape with
one extra rule — *no path is allowed to get much longer than any other.*

```
  BST search vs the balance problem (you built the left side)

  BALANCED (B-tree-ish)          DEGENERATE (plain BST, sorted inserts)
        [50]                      [10]
       /    \                         \
    [25]    [75]                       [20]
    /  \    /  \                          \
  [10][30][60][90]                         [30]
  search 60: 50→75→60            search 60:  10→20→30→...→60
  depth 3, O(log n)              depth n, O(n)  ← the skew your BST allows
```

One sentence: **a balanced tree keeps every root-to-leaf path roughly the same
length, so lookup stays O(log n) no matter the insert order — which a plain
BST can't promise.** A **trie** is a different tree entirely: nodes are
*characters*, paths spell *strings*, and shared prefixes share nodes.

### Move 2 — the trees buffr actually leans on (and the one it lacks)

**The B-tree — buffr's primary key and `app_id` index.** Every `chunks` row
has `id text primary key` (`sql/001_agents_schema.sql:15`) and a secondary
index (`:30`):

```sql
create index if not exists chunks_app_id on agents.chunks (app_id);
```

Both are B-trees (Postgres's default index type). When `search` filters `where
app_id = $2` (`src/pg-vector-store.ts:75`), Postgres can walk the `app_id`
B-tree instead of scanning every row. When `upsert` does `on conflict (id)`
(`:50`), it walks the primary-key B-tree to find the existing row. A B-tree is
a BST generalised: each node holds *many* keys and has *many* children (wide
fan-out), so the tree is shallow — a few levels covers millions of rows.

```
  B-tree — wide fan-out keeps it shallow (Postgres index)

  ┌────── one node holds MANY keys ──────┐
  │  [ k1 | k2 | k3 | ... | k_m ]        │   ← m can be hundreds
  └───┬────┬────┬─────────────┬──────────┘
      ▼    ▼    ▼             ▼
    subtree subtree ...    subtree         depth = log_m(n)
                                            m large → very shallow
  millions of rows → 3-4 levels → 3-4 disk reads per lookup
```

The *why a B-tree and not your BST* is the storage-engine reason: each node is
a disk page, and wide fan-out minimises page reads. That mechanism — pages,
fan-out, the build cost — belongs to **`study-database-systems`**; this file
owns the tree *shape* and the balance guarantee.

**The HNSW index is a graph, NOT a tree — a deliberate contrast.** It's easy
to assume the vector index is also a tree. It isn't (`sql/001:28-29`):

```sql
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

A tree has one parent per node and no cycles; HNSW is a *navigable
small-world graph* — many links per node, cycles everywhere (file `05`). Trees
work when you can split the space cleanly in two at each node (a single key has
a well-defined "less than"). In 768 dimensions there's no single axis to split
on, so the tree shape breaks down and a graph takes over. Naming *why the tree
stops working in high dimensions* is the insight here.

**The trie — not yet exercised, and the clearest gap.** A **trie** stores
strings as paths of character-nodes, so all words sharing a prefix share the
top of the tree:

```
  Trie — prefix tree (NOT in buffr; here's the shape to drill)

        (root)
        /    \
      c        d
      │         \
      a          o
     / \          \
    t   r          g
    │   │          │
  "cat""car"     "dog"
  lookup "car": walk c→a→r, O(length) — independent of how many words stored
  shared prefix "ca" stored ONCE → prefix queries ("all words starting ca") cheap
```

Where it would land in buffr: prefix search or autocomplete over document
content — "show me docs whose title starts with…" Today buffr does *semantic*
search (vectors, file `02`), never *prefix* search, so there's no trie. This
is **not yet exercised** in buffr **and** absent from your reincodes portfolio
(`me.md` lists tries under "less depth"). That double-absence is why the
practice map (file `08`) ranks it high: it's genuinely new structure for you,
and it's the natural complement to the semantic search you already have.

**The BST you built — where it sits now.** Your `BinarySearchTree.ts` with
recursive+iterative insert/search/delete and successor/predecessor is the
*foundation* both B-trees and balanced trees generalise. buffr doesn't use it
directly, but understanding it is what makes the B-tree's balance guarantee
legible: you know what goes wrong without balance because you built the version
that can skew.

### Move 3 — the principle

**Balance is a guarantee you pay for on every write to collect on every read.**
A plain BST is cheaper to insert into and risks O(n) lookups; a balanced tree
does extra rebalancing work per insert so lookups are *always* O(log n). And
when the data is high-dimensional, even balance isn't enough — the tree shape
itself fails, and you switch to a graph (HNSW). The skill is recognising which
regime you're in: low-dimensional ordered keys → balanced tree; string prefixes
→ trie; high-dimensional vectors → graph.

---

## Primary diagram

The tree family in buffr, with the gaps marked.

```
  Trees & indexes — buffr-laptop recap

  USED (indirectly, via Postgres):
  ┌─ B-tree: chunks.id PK, chunks_app_id ─┐  sql/001:15,30
  │  balanced, O(log n) guaranteed         │  used by upsert on-conflict,
  │  wide fan-out, shallow                  │  app_id filter in search
  └─────────────────────────────────────────┘

  NOT a tree (common misconception):
  ┌─ HNSW: the vector index ─┐  sql/001:28 → file 05
  │  a GRAPH, not a tree      │  trees break in 768 dimensions
  └───────────────────────────┘

  NOT YET EXERCISED (the gaps):
  ┌─ trie ─────────────────┐  ┌─ self-balancing internals ──┐
  │ prefix/autocomplete     │  │ red-black / AVL rotations    │
  │ absent in buffr + repo  │  │ (you built unbalanced BST)   │
  │ → drill, file 08        │  │ → understand, file 08        │
  └─────────────────────────┘  └──────────────────────────────┘
```

---

## Elaborate

The B-tree (Bayer & McCreight, 1970) was invented *specifically* for
disk-backed databases — the wide fan-out exists because disk reads are the
bottleneck, so you want maximum keys per page. That's why it, not your
in-memory BST, is what Postgres reaches for. The trie (Fredkin, 1960) solves
the orthogonal problem: lookup by *prefix* in time proportional to key length,
not to the number of keys — the backbone of autocomplete and IP routing tables.

The honest portfolio note: you've built the BST foundation but not its
*balanced* descendants (red-black, AVL) and not the trie. For interviews and
for understanding why databases pick the indexes they do, the balanced
rotations and the trie are the two highest-value additions — file `08`
sequences them.

---

## Interview defense

**Q: Postgres indexes buffr's keys with a B-tree, not a plain BST. Why?**

```
  plain BST  │ O(log n) only if balanced; sorted inserts → O(n) chain
  B-tree     │ self-balances every insert → O(log n) GUARANTEED
             │ + wide fan-out → fewer disk page reads
```

Answer: a plain BST's depth depends on insert order — sequential keys (common
for ids) degrade it to a linked list, O(n) lookups. A B-tree rebalances on
every insert so depth stays O(log n) regardless, and its wide fan-out
minimises disk reads. The part people forget: balance is a *write-time* cost
paid to guarantee *read-time* performance.

Anchor: *"A B-tree is a BST that refuses to skew, with fan-out tuned to disk
pages — that's why databases use it and not the textbook BST."*

**Q: The vector index is HNSW. Why isn't it a tree?**

```
  trees split space on ONE key per node ("< or ≥")
  768 dimensions → no single axis to split on → tree shape fails
  → switch to a navigable graph (HNSW), many links per node
```

Answer: trees rely on a clean two-way split at each node, which needs a single
ordering dimension. In 768-D embedding space there's no such axis, so
tree-based indexes degrade toward a full scan ("curse of dimensionality"); a
graph index sidesteps it by linking near-neighbours directly. The detail that
signals depth: it's the dimensionality, not the data size, that kills the tree.

Anchor: *"Trees need one axis to split on; high-dimensional vectors don't have
one, so you switch to a graph."*

---

## See also

- `02-arrays-strings-and-hash-maps.md` — the hash index, the other way to get
  fast lookup (O(1), unordered) vs a B-tree (O(log n), ordered).
- `05-graphs-and-traversals.md` — why the vector index is a graph, and how the
  walk works.
- `08-dsa-foundations-practice-map.md` — where tries and balanced-tree
  internals rank in the drill plan.
- **`study-database-systems`** — the storage-engine side: pages, fan-out,
  index build cost.

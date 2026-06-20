# DSA Foundations — Practice Map

**ranked learning plan / exercised-first, gaps-second** — *Project-specific*

## Zoom out, then zoom in

This is the audit file: the ranked verdict on what buffr exercises, what it
doesn't, and — given your reincodes portfolio — what's actually worth your time.
The honest headline: **buffr exercises very little classic DSA in its own source,
the interesting algorithm (HNSW) is rented from a C extension, and the highest-
value gaps (DP, backtracking, quickselect, tries) are absent from both the repo
and your portfolio.**

```
  Zoom out — the practice map, three tiers

  ┌─ TIER 1: exercised here, you own it ─────────────────┐
  │  Map/Set, cosine-over-arrays, sliding-window chunker, │ ← reinforce,
  │  top-k selection, graph traversal (HNSW family)       │   don't re-learn
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ TIER 2: adjacent, half-built ───────────────────────┐
  │  heap-for-top-k (built the heap, repo uses sort),     │ ← close the
  │  quickselect (built quicksort, not the select variant)│   gap, small effort
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ TIER 3: absent from repo AND portfolio ─────────────┐
  │  dynamic programming, backtracking, tries, union-find,│ ← deliberate
  │  building HNSW from scratch, binary search in anger    │   practice targets
  └───────────────────────────────────────────────────────┘
```

Zoom in: this file ranks every concept from the guide by *consequence* — how
load-bearing it is in the system — and by *gap size* — how far it is from what you
already own. The question it answers: *if you have ten hours, where do they go?*

## The structure pass

Trace **one axis — "is this a reinforce or a fill-the-gap?" — across the
concepts.**

```
  Axis = "do I already own this, or is it a gap?"

  ┌─ exercised + owned ─────────────────────┐
  │ graph traversal, Map/Set, sort+slice     │  REINFORCE — anchor new
  │                                          │  learning to repo evidence
  └──────────────────────┬───────────────────┘
                         │  seam: have-the-piece vs missing-it
  ┌─ half-built ──────────▼────────────────┐
  │ heap-for-top-k, quickselect             │  CONNECT — you built the
  │                                          │  component, wire it in
  └──────────────────────┬───────────────────┘
                         │  seam: adjacent vs net-new
  ┌─ net-new ─────────────▼────────────────┐
  │ DP, backtracking, tries, union-find      │  BUILD — absent everywhere,
  │                                          │  needs a from-scratch drill
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between "half-built" (you own the component, the repo
just doesn't wire it) and "net-new" (absent from repo *and* your portfolio). The
first kind closes in an afternoon — swap a sort for your heap. The second kind is
real curriculum work — a from-scratch build with a visualizer. Sorting your hours
by which side of that seam a concept sits on is the entire plan.

## How it works

### Move 1 — the ranking

The plan is ranked, not a flat list. Top items are highest leverage: either
load-bearing in the system *or* the biggest gap from your portfolio.

```
  The ranked practice map — exercised first, gaps second

  RANK  CONCEPT                  STATUS          LEVERAGE   FILE
  ──────────────────────────────────────────────────────────────
  1  graph traversal / HNSW    exercised, owned  HIGHEST    05
       └ the system's hot path; you own the family — reinforce
  2  top-k: heap vs sort        half-built        HIGH       03,06
       └ built the heap, repo sorts — connect in an afternoon
  3  cosine over arrays         exercised, owned  HIGH       02
       └ the one hand-written math; solid, just internalize
  4  Map/Set + complexity       exercised, owned  MEDIUM     01,02
       └ workhorse; reinforce amortized-O(1) reasoning
  5  quickselect                half-built        MEDIUM     06
       └ built quicksort, not the select variant — small build
  6  dynamic programming        ABSENT everywhere HIGH(gap)  07
       └ thin in portfolio AND repo — real curriculum target
  7  backtracking               ABSENT everywhere MEDIUM(gap)07
       └ did state-space BFS, not undo-based search
  8  tries / prefix structures  ABSENT everywhere MEDIUM(gap)04
       └ absent from buffr and reincodes — distinct mental model
  9  binary search in anger     ABSENT in buffr   LOW(gap)   06
       └ verify it's solid in reincodes; trivial to re-prove
  10 building HNSW from scratch ABSENT (rented)   STRETCH    05
       └ the deepest drill: own the graph you currently rent
```

### Move 2 — the plan, tier by tier

**Tier 1 — reinforce what the repo proves you own.**
Graph traversal, Map/Set, cosine-over-arrays, sort+slice top-k. Bridge: these are
already in your hands — the repo is *evidence*, not a lesson. The move here isn't
to re-learn; it's to be able to point at `src/pg-vector-store.ts:74` and say "this
is greedy graph search, same family as my BFS." Where it breaks: don't spend your
ten hours here — you'd be polishing what already shines.

```
  Tier 1 — anchor, don't re-learn

  reincodes Graph.ts BFS  ──maps to──►  pgvector HNSW walk (file 05)
  reincodes Sorting/      ──maps to──►  in-mem sort+slice (file 06)
  the work: articulate the mapping, not rebuild the piece
```

**Tier 2 — connect the components you've already built.**
The heap-for-top-k and quickselect. Bridge: you built `BinaryHeap.ts` and
quicksort; the repo just doesn't use them. The move is a concrete, small wire-in.
Where it breaks: this is the *highest ROI* tier — you get a real complexity story
(`O(n log n)` → `O(n log k)`) for an afternoon's work, and it's the kind of change
that demonstrates judgment in an interview.

```
  Tier 2 — the afternoon wins

  EXERCISE: replace in-mem store's hits.sort().slice(0,k)
            with a size-k min-heap (copy BinaryHeap.ts)
  Done when: same top-k results, O(n log k), a benchmark showing
             the crossover where the heap wins at large n
  Effort: ~half a day. Highest leverage per hour in this map.
```

**Tier 3 — build the net-new fundamentals.**
DP, backtracking, tries, union-find — absent from both buffr and your portfolio.
Bridge: there's no component to wire here; these need from-scratch builds. The
move is one focused drill each, in the format that makes things real for you —
build it, visualize it. Where it breaks: DP ranks highest because `me.md` flags it
as thin in your portfolio *and* it's the most common senior-interview gap. Tries
and union-find are real but lower-frequency.

```
  Tier 3 — the curriculum builds (ranked)

  1. DP: edit distance OR LCS, bottom-up table + visualizer  ← highest
  2. backtracking: N-queens or Sudoku, choose/recurse/undo
  3. trie: autocomplete over chunk text (could even land in buffr)
  4. union-find: connected components (your PG.ts could use it)
       │
       └─ each is a from-scratch build, the format that makes it real for you
```

### Move 2.5 — the stretch: own the algorithm you rent

The deepest drill in the map: build a small HNSW (or even a brute-force-then-
navigable-graph) from scratch in TypeScript. Right now buffr *rents* the most
important algorithm in the system from pgvector's C extension. Building a toy
version — nodes, proximity edges, greedy layered walk — would convert "I use a
vector index" into "I understand and have built approximate nearest neighbor."

```
  Phase A (now): rent it          Phase B (stretch): own it

  pgvector HNSW, invisible    →   hand-built navigable graph in TS
  "I call order by <=>"           "I built the greedy layered walk"
       │                               │
  uses your graph skills          PROVES your graph skills, end to end
  indirectly                      with a visualizer (your format)
```

This is the single drill that would most strengthen the story your portfolio
already tells — it sits directly on top of your `Graph.ts` and `PriorityQueue.ts`.

### Move 3 — the principle

**Spend hours where leverage is highest: connect half-built components first
(cheap, high signal), then build net-new fundamentals the repo can't teach you.**
Don't re-learn what the repo already proves you own. The map's whole job is to
stop you polishing Tier 1 when Tiers 2 and 3 are where the growth is.

## Primary diagram

The complete map: every concept, its status, and the recommended action.

```
  The full practice map — recap

  EXERCISED + OWNED (reinforce)         HALF-BUILT (connect — best ROI)
  ┌──────────────────────────┐          ┌──────────────────────────┐
  │ HNSW graph walk    (05)  │          │ heap-for-top-k    (03,06)│
  │ cosine over arrays (02)  │          │ quickselect       (06)   │
  │ Map / Set          (02)  │          └──────────────────────────┘
  │ sort+slice top-k   (06)  │                     │
  │ complexity models  (01)  │                     ▼
  └──────────────────────────┘          NET-NEW (build — curriculum gaps)
                                         ┌──────────────────────────┐
  STRETCH (own what you rent)            │ dynamic programming (07) │ ★ highest
  ┌──────────────────────────┐          │ backtracking        (07) │
  │ build HNSW from scratch  │          │ tries               (04) │
  │ (05) — caps the story    │          │ union-find          (05) │
  └──────────────────────────┘          │ binary search       (06) │
                                         └──────────────────────────┘
```

## Implementation in codebase

**Use cases.** This map is reached for when you plan study time, prep for an
interview that will probe DSA, or decide what to build next on top of buffr. Each
ranked item ties to a real `file:line` in the repo (or an honest "absent").

```
  The evidence behind each rank — where to look

  graph traversal   src/pg-vector-store.ts:74  + sql/001_agents_schema.sql:28
  heap vs sort      @aptkit/retrieval in-memory-vector-store.js (hits.sort)
  cosine math       @aptkit/retrieval in-memory-vector-store.js (cosineSimilarity)
  Map / Set         in-memory store (new Map) + src/cli/eval-cmd.ts:26 (new Set)
  quickselect       — absent; reincodes quicksort is the starting point
  DP / backtracking — absent everywhere (the file-07 finding)
  tries / union-find— absent everywhere (file-04 / file-05 findings)
```

```
  Tier-2 exercise target — the exact line to change

  @aptkit/retrieval in-memory-vector-store.js  (search)

  hits.sort((a, b) => b.score - a.score);   ← REPLACE this O(n log n)
  return hits.slice(0, Math.max(0, k));      ← with a size-k min-heap
       │
       └─ (note: this lives in the library, not buffr — so the realistic
          exercise is a standalone reimplementation in your own repo using
          BinaryHeap.ts, proving the O(n log k) crossover, not editing aptkit
          which buffr's constraints forbid touching)
```

## Elaborate

The framing this map uses — exercised vs half-built vs net-new — comes straight
from `me.md`'s honest portfolio accounting: you're strong on graphs, heaps, BSTs,
sorting, and recursion-with-memoization; thinner on DP-beyond-memoization,
backtracking, tries, union-find, segment trees. buffr happens to exercise exactly
the strong half (graphs, top-k, hashing) and none of the thin half — which is why
this guide can *reinforce* the first and only *teach* the second.

The strategic read: buffr is a system-design and AI-engineering artifact, not a
DSA showcase. Its DSA value is (1) proving you can recognize the graph/heap/hash
fundamentals inside a production retrieval path, and (2) making the gaps visible.
Use `study-database-systems` and `study-ai-engineering` as the primary homes for
buffr's real depth; use *this* guide to anchor DSA vocabulary and to sequence the
fundamentals the repo can't teach you.

## Interview defense

**Q: This repo is mostly a thin wrapper. What DSA does it actually demonstrate?**

```
  the honest answer — recognition, not reinvention

  exercised: graph search (HNSW), top-k selection, hashing, cosine math
  the skill it proves: spotting fundamentals inside a production path,
                       not hand-rolling them
```

Answer: "Recognition. The headline algorithm is approximate nearest neighbor over
a navigable small-world graph — that's graph traversal, the family I built BFS,
DFS, and Dijkstra in. Top-k is a selection problem, hashing backs the store, and
cosine is the one hand-written piece of math. What the repo proves isn't that I
reinvent these — it's that I see them inside a real system and know the tradeoffs,
like recognizing the in-memory sort should be a heap." Anchor:
`src/pg-vector-store.ts:74`.

**Q: Where would you invest to strengthen the DSA story?**

Answer: "Three moves, ranked. One: wire my `BinaryHeap` into a top-k
reimplementation — afternoon's work, real `O(n log n)` → `O(n log k)` story. Two:
build a DP classic with a visualizer — it's the gap in both this repo and my
portfolio. Three, the stretch: build a toy HNSW from scratch, so I *own* the
algorithm buffr currently rents from pgvector. That last one sits directly on my
existing `Graph.ts` and `PriorityQueue.ts`." Anchor: this map, ranks 2, 6, 10.

## Validate

1. **Reconstruct.** From memory, name the three tiers (exercised/owned,
   half-built, net-new) and one concept in each.
2. **Explain.** Why is "wire in the heap for top-k" the highest-ROI item, given
   you already built `BinaryHeap.ts`? (Component exists; afternoon to connect; real
   complexity story.)
3. **Apply.** You have ten hours before a senior DSA interview. Allocate them
   across the ranked map and justify each block.
4. **Defend.** Argue why buffr's *thin* DSA surface is consistent with it being a
   strong portfolio piece. (It's a system-design/AI artifact; its DSA value is
   recognition inside a production path, plus making gaps visible.)

## See also

- `00-overview.md` — the repo-grounded map and the `not yet exercised` list.
- `05-graphs-and-traversals.md` — rank-1 concept; the HNSW story.
- `03-stacks-queues-deques-and-heaps.md` / `06-sorting-searching-and-selection.md`
  — rank-2; the heap-vs-sort connect.
- `07-recursion-backtracking-and-dynamic-programming.md` — rank-6/7; the net-new
  curriculum gaps.
- `study-ai-engineering` / `study-database-systems` — where buffr's real depth
  lives; this guide is the DSA-vocabulary layer beneath them.

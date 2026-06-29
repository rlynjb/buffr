# DSA Foundations — Practice Map

**Industry name(s):** spaced practice plan · DSA drill sequencing —
*Project-specific*

The ranked learning plan: what buffr exercises (consolidate it), then the
foundations buffr *and* your portfolio lack (the real ROI). This file is the
verdict-first close — it tells you what to drill, in what order, and why each
earns its place.

---

## Zoom out — the practice ladder

Two tiers: consolidate what's already real, then close the gaps. The
zoom-out is the whole plan on one ladder.

```
  Zoom out — the practice ladder for buffr-laptop

  ┌─ TIER 1: exercised in buffr — consolidate (you mostly have these) ─┐
  │  cosine similarity + top-k selection   (files 02, 06)              │
  │  hash set / hash map                   (file 02)                    │
  │  graph traversal as ANN                (file 05) ← your strength    │
  └───────────────────────────┬────────────────────────────────────────┘
                              │ then climb to:
  ┌─ TIER 2: NOT exercised — the real ROI (new for you) ──────────────┐
  │  ★ dynamic programming ★★★   absent in buffr AND portfolio        │ ← drill first
  │  tries ★★                    absent in both                        │
  │  union-find ★★               absent in both                        │
  │  balanced-tree internals ★   you built unbalanced BST              │
  │  size-k heap for top-k ★     you have the heap, not this use       │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"given a strong graph/heap/BST/sorting portfolio
and a repo that exercises only retrieval-shaped DSA, what's the highest-leverage
thing to build next?"** Verdict: **dynamic programming**, then **tries** and
**union-find**. The reasoning and per-gap build plans follow.

---

## Structure pass — the ranking axis

**Axis: leverage = (gap size) × (transferability) ÷ (prerequisite distance).**
A gap ranks high when it's genuinely absent, shows up everywhere in interviews
and real systems, and you already hold its prerequisites.

```
  Axis: "what's the highest-leverage drill?" — traced across the gaps

  DP            │ big gap × very transferable ÷ short distance (you have recursion)
                │  → HIGHEST. you're one "add a cache" reflex away.
  tries         │ big gap × moderately transferable ÷ medium distance
                │  → HIGH. genuinely new structure, clear use (prefix search)
  union-find    │ big gap × transferable ÷ short distance (it's simple)
                │  → HIGH. tiny structure, huge interview presence
  balanced BST  │ medium gap × transferable ÷ short (you have plain BST)
                │  → MEDIUM. understand-level, not build-level
  size-k heap   │ small gap × transferable ÷ ~zero (you have the heap)
                │  → LOW effort, do it as a warm-up
```

The seam in the ranking: **prerequisite distance.** DP and union-find rank
high partly because they're *close* to what you already own — DP is recursion
(you have it) plus a cache; union-find is a tiny array-backed structure. Tries
are slightly further (a genuinely new tree shape) but the use case is concrete.

---

## How it works — the ranked plan

### Move 1 — the shape of the plan

Consolidate the exercised tier fast (you mostly have it), then spend real time
on the gap tier. The order within the gap tier is by leverage, not by
textbook chapter.

```
  The plan — consolidate, then climb

  TIER 1 (days, not weeks — you have these)
  ─ size-k heap top-k     warm-up: wire your BinaryHeap into a top-k function
  ─ cosine + selection    re-derive from pg-vector-store.ts:69-77 by hand

  TIER 2 (the real work — ranked by leverage)
  1 ─ dynamic programming  edit distance → knapsack (token-budget framing)
  2 ─ tries                prefix search over doc titles
  3 ─ union-find           dedup clusters / connected components
  4 ─ balanced-tree internals  understand rotations (not build)
```

### Move 2 — the gaps, ranked, each as a drill

**Tier 1 warm-ups — consolidate what's real (do these first, fast).**

*Size-k heap for top-k.* You have `BinaryHeap.ts` and `PriorityQueue.ts`;
you've never wired them into bounded top-k selection (file `03`). Build a
`topK(distances, k)` using a size-k max-heap, prove it returns the same result
as sort+slice, and benchmark the O(n log k) vs O(n log n) gap at large n. One
sitting. It connects your existing heap to buffr's selection operation.

*Cosine + selection by hand.* Re-derive `1 - (embedding <=> $1)`
(`src/pg-vector-store.ts:69-72`) and the `order by ... limit k` from scratch:
compute cosine similarity between two `number[]` arrays, then top-k them. Cements
that buffr's whole search reduces to array math + selection.

**Gap 1 — Dynamic programming (★★★ highest leverage).**

```
  DP drill — recursion you have + a cache you don't

  STEP 1  naive recursive edit distance        → see the O(2^n) recomputation
  STEP 2  add a memo (top-down DP)              → O(m·n), recursion + cache
  STEP 3  rewrite as a table (bottom-up)        → no call stack, same answer
  STEP 4  knapsack: chunk selection under       → the buffr-relevant landing:
          maxTokens=8192 (session.ts:46)           session.ts:46 token budget
```

Why first: it's your thinnest area (`me.md`) *and* the closest to your
existing skill — you write recursion already (`Tree.ts`, `PG.ts`), so DP is
the "add a cache, recognise overlap" reflex on top. Highest gap × shortest
prerequisite distance. Build edit distance, then the knapsack framing that maps
onto buffr's `ContextWindowGuardedProvider` token budget — that gives you a DP
example anchored to a real system, not a toy. Done when you can rebuild the 2-D
table from memory and name the optimal-substructure + overlapping-subproblems
pair in a new problem.

**Gap 2 — Tries (★★ high).**

```
  Trie drill — a genuinely new tree shape

  STEP 1  build a trie: insert / search / startsWith  (char-node paths)
  STEP 2  load doc titles from agents.documents into it
  STEP 3  prefix query: "all titles starting with X"  → O(length), not O(n)
```

Why: absent from buffr *and* your portfolio (file `04`), with a concrete
landing — prefix/autocomplete search over document content, the natural
complement to buffr's semantic search. New structure, clear payoff. Done when
prefix lookup is O(query length) independent of corpus size.

**Gap 3 — Union-find (★★ high).**

```
  Union-find drill — tiny structure, huge interview presence

  STEP 1  build: parent[] array, find() + union()
  STEP 2  add path compression + union by rank      → near-O(1) amortized
  STEP 3  apply: cluster near-duplicate chunks (those within ε cosine distance)
```

Why: it's small (an array plus two operations) so the prerequisite distance is
near zero, yet it's everywhere in interviews (connected components, Kruskal's
MST, dedup). The buffr landing: clustering near-duplicate retrievals. Note the
*conceptual* link to your `numberOfConnectedComponents` in `Graph.ts` — same
problem, different structure (you solved it with traversal; union-find is the
other canonical way). Done when you can explain why path compression makes it
near-constant amortized.

**Gap 4 — Balanced-tree internals (★ understand-level).**

```
  Balanced-tree drill — understand, don't necessarily build

  STEP 1  read why your BinarySearchTree.ts skews on sorted inserts
  STEP 2  understand ONE rotation (left/right) and how it restores balance
  STEP 3  connect to Postgres B-tree (file 04) — why DB indexes self-balance
```

Why understand-not-build: you have the plain BST (`BinarySearchTree.ts`); the
gap is the *balance guarantee*, which is conceptual leverage (it explains every
DB index in buffr) more than a from-scratch build. Lower effort, real payoff
for reasoning about the storage layer. Done when you can explain why
`chunks_app_id` (`sql/001:30`) stays O(log n) regardless of insert order.

### Move 3 — the principle

**Drill the gaps closest to your strengths first — that's where reps compound
fastest.** DP ranks first not because it's the most exotic but because you're
one reflex away: the recursion is already in your hands. Union-find ranks high
because it's tiny. The leverage isn't "hardest topic" — it's "biggest gap you
can close fastest with what you already own." That's how a strong-but-uneven
portfolio gets evened out efficiently.

---

## Primary diagram

The full practice map, ranked, one frame.

```
  DSA practice map — buffr-laptop, ranked (recap)

  HAVE & EXERCISED (consolidate, days)
  ├─ graph traversal / ANN     file 05  ← your strongest, buffr's headline
  ├─ hash set / map            file 02
  ├─ cosine + top-k selection  files 02,06
  └─ heap / priority queue     file 03  (warm-up: wire into top-k)

  GAPS, RANKED BY LEVERAGE (the real work, weeks)
  1 ★★★ dynamic programming   recursion+cache · edit dist → knapsack(maxTokens)
  2 ★★  tries                 prefix search over doc titles
  3 ★★  union-find            cluster dedup · near-O(1) amortized
  4 ★   balanced-tree internals  rotations · why DB indexes self-balance
       └ warm-up ★ size-k heap top-k  (you have the heap, not this use)

  rule: gap size × transferability ÷ prerequisite distance = drill order
```

---

## Elaborate

This map is deliberately uneven because your portfolio is — strong on graphs,
heaps, BSTs, sorting (the IK set), thin on DP, tries, union-find. The plan
spends almost no time re-teaching the strong areas (consolidation, not
instruction) and concentrates on the four gaps. The ordering principle —
*closest-to-existing-skill first* — is what makes it efficient: you bank a win
(DP, because you have recursion) before tackling the genuinely-new structure
(tries).

Where this connects back: every gap here was flagged "not yet exercised" in its
home file (`04` tries + balanced trees, `07` DP + backtracking), and union-find
connects to your existing `Graph.ts` connected-components work. The whole guide
points here, and this file points back to the builds.

---

## Interview defense

**Q: Your portfolio is strong on graphs and heaps but light on DP. How would
you close that?**

```
  DP = recursion (have) + cache (gap) + overlap-recognition (the real skill)
  plan: edit distance → memoize → tabulate → knapsack(token budget)
  anchor it to a real system, not a toy: session.ts:46 maxTokens
```

Answer: I'd start with DP because it's my thinnest area *and* closest to what I
already do — I write recursion (Tree traversals, a river-crossing state-space
DFS), so the gap is specifically memoization and recognising overlapping
subproblems. I'd build edit distance, then frame chunk-selection-under-a-token-
budget as knapsack, which anchors DP to a real RAG concern instead of a toy.

Anchor: *"DP is recursion plus a cache — I have the recursion, so I'm drilling
the cache reflex and the overlap-recognition, anchored to a real token-budget
problem."*

**Q: Why drill in this order rather than hardest-first?**

```
  leverage = gap × transferability ÷ prerequisite distance
  DP & union-find rank high partly because they're CLOSE to what I own
  → bank fast wins where reps compound, not just chase difficulty
```

Anchor: *"I sequence by leverage, not difficulty — closest-to-my-strengths
first, because that's where the reps compound fastest."*

---

## See also

- `00-overview.md` — the repo-grounded map and the `not yet exercised` summary.
- `04-trees-tries-and-balanced-indexes.md` — the trie and balanced-tree gaps in
  full.
- `05-graphs-and-traversals.md` — your strongest area, buffr's headline.
- `07-recursion-backtracking-and-dynamic-programming.md` — the DP gap and its
  buffr landing spot.
- **`study-ai-engineering`** — the retrieval-quality work the DP drills would
  improve.

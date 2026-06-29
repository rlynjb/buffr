# Recursion, Backtracking & Dynamic Programming

**Industry name(s):** recursion / call stack · backtracking (DFS over a
state space) · dynamic programming (memoization / tabulation) — *Industry
standard*

The leading nouns: **recursion** (a function calling itself, backed by the
call stack), **backtracking** (DFS that undoes choices), **dynamic
programming** (reuse overlapping subproblems). buffr exercises only the
*lightest* recursion (transactional batch loops, not even truly recursive),
and **DP is entirely absent** — making this the file that's most honest about
a gap, in buffr *and* in your portfolio.

---

## Zoom out — where recursion and DP would live

buffr's code is almost entirely flat iteration. The zoom-out is mostly about
what *isn't* here and where it would go.

```
  Zoom out — recursion & DP in (and missing from) buffr

  ┌─ buffr source ─────────────────────────────────────────────┐
  │  upsert: a flat for-loop in a transaction (not recursive)  │ ← we are here
  │  eval: a flat for-loop over queries                         │
  │  no backtracking, no DP anywhere                            │
  └───────────────────────────┬────────────────────────────────┘
                              │ recursion DOES appear, hidden:
  ┌─ Postgres / HNSW ─────────▼────────────────────────────────┐
  │  B-tree walk + HNSW walk are recursive descents (in C)      │  files 04,05
  └───────────────────────────┬────────────────────────────────┘
                              │ DP would land in retrieval QUALITY:
  ┌─ not yet exercised ───────▼────────────────────────────────┐
  │  edit distance (fuzzy match), sequence alignment, re-ranking│
  │  ★ DP — absent in buffr AND your reincodes portfolio ★      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"what problems need a recursive state-space search
or overlapping-subproblem reuse — and does buffr have any?"** The honest
answer: buffr has essentially none, and DP is your single biggest portfolio
gap (`me.md` lists it under "less depth"). This file teaches the fundamentals
against where they *would* land, and ranks DP first in the drill plan.

---

## Structure pass — layers, axis, seams

**Axis: who remembers prior work?** Trace it from plain recursion (remembers
nothing, recomputes) to DP (remembers everything, computes each subproblem
once). The seam — *memoization* — is the entire difference between exponential
and polynomial.

```
  Axis: "is prior work remembered or recomputed?" — traced

  ┌─ plain recursion ─────────────────────┐
  │  recomputes overlapping subproblems    │   → can be EXPONENTIAL
  │  (naive fib: O(2^n))                    │
  └───────────────┬───────────────────────┘
      seam: cache subproblem results?  (THE flip: exp → poly)
      ┌───────────▼───────────────────────┐
      │ memoization (top-down DP)           │   → each subproblem once, O(n)
      │  recursion + a cache                │
      └───────────────┬────────────────────┘
      seam: fill the cache bottom-up instead?
          ┌──────────▼──────────────────────┐
          │ tabulation (bottom-up DP)         │   → same results, no call stack
          └───────────────────────────────────┘
```

The load-bearing seam: **memoization is just recursion plus a cache** — and
that one addition collapses exponential recomputation to polynomial. Naming DP
as "recursion that remembers" (rather than a separate mysterious technique) is
the unlock, especially since you already write the recursion half.

---

## How it works

### Move 1 — the mental model

You visualized the call stack. Your `Tree.ts` traversals and recursion
call-stack visualizers are the foundation: recursion is a function that defers
part of its work to a copy of itself, and the **call stack** is the implicit
stack (file `03`) holding the deferred frames. DP adds one thing: a table that
remembers each subproblem's answer so you never solve it twice.

```
  Recursion → DP — add a memo, kill the recomputation

  NAIVE RECURSION (fib)          MEMOIZED (DP)
  fib(5)                         fib(5)
  ├ fib(4)                       ├ fib(4) ──► store
  │ ├ fib(3) ◄─┐                 │ ├ fib(3) ──► store
  │ │ ├ fib(2) │ recomputed      │ │ ├ fib(2) ──► store
  │ └ fib(2) ◄─┘ AGAIN           │ └ fib(2) ◄ CACHE HIT (O(1))
  └ fib(3) ◄──── recomputed      └ fib(3) ◄──── CACHE HIT
  O(2^n) — same subproblems      O(n) — each subproblem solved ONCE
  solved over and over
```

One sentence: **DP is recursion over overlapping subproblems plus a cache so
each subproblem is solved exactly once — turning exponential into
polynomial.** Backtracking is the other branch: recursion that *tries a choice,
recurses, and undoes it* if it fails — your river-crossing puzzle (`PG.ts`) is
this, a DFS over a state space.

### Move 2 — the parts, against where they land in buffr

**Recursion — present only in its lightest form.** buffr's loops are flat, not
recursive. `upsert` (`src/pg-vector-store.ts:43-57`) is a `for` loop inside a
transaction:

```ts
for (const c of chunks) {              // ← flat iteration, NOT recursion
  // ... build insert ...
  await client.query(`insert ... on conflict (id) do update ...`, [...]);
}
```

No self-call, no call stack growth, no base case. This is iteration, and
correctly so — batch upsert has no recursive structure to exploit. The honest
note: buffr's own TypeScript contains *no meaningful recursion*. The recursion
in this system is the **recursive descent** inside the B-tree and HNSW index
walks (files `04`, `05`) — but that's C code in Postgres, not buffr's source.

**Backtracking — not yet exercised, but you've built the canonical example.**
Backtracking is DFS over an implicit state space with undo. You built exactly
this: `PG.ts`, the river-crossing puzzle, BFS/DFS over a state graph generated
from rules. Here's the skeleton you already own:

```
  Backtracking — try, recurse, undo (your PG.ts shape)

  SOLVE(state):
    if state is goal: return success
    for each legal move from state:        // generate choices from rules
      apply move → newState                // make the choice
      if SOLVE(newState) succeeds: return success
      undo move                            // ← BACKTRACK: the load-bearing line
    return failure                          // exhausted choices, dead end

  drop the "undo" → state corrupts across sibling branches → wrong answers
```

Where it would land in buffr: nowhere currently — buffr has no constraint-
satisfaction or puzzle-search problem. If buffr ever did query planning or
multi-step tool selection with rollback, that's backtracking territory. Today
it's a foundation you hold but the repo doesn't exercise.

**Dynamic programming — entirely absent, the headline gap.** There is *no DP
in buffr*, and per `me.md` it's the thinnest area of your portfolio too ("DP
beyond the classic recursion-with-memoization patterns"). This is the single
highest-value thing to drill. Where it *would* land in a system like buffr:

```
  Where DP would enter a RAG system (NOT YET EXERCISED)

  ┌─ edit distance (Levenshtein) ─┐  fuzzy-matching a query to doc titles,
  │  DP table over two strings     │  typo-tolerant lookup — classic 2-D DP
  └────────────────────────────────┘
  ┌─ sequence alignment ──────────┐  matching query terms to passages
  │  same DP family as edit dist   │  in order — re-ranking retrieved chunks
  └────────────────────────────────┘
  ┌─ weighted re-ranking ─────────┐  optimal selection under a token budget
  │  knapsack-shaped DP             │  (which chunks fit in the context window)
  └────────────────────────────────┘
```

The last one is the most buffr-relevant: `ContextWindowGuardedProvider(...,
{ maxTokens: 8192 })` (`src/session.ts:46`) caps the context window. *Choosing
which retrieved chunks to keep under that token budget to maximise relevance*
is a knapsack problem — textbook DP. buffr doesn't do this (it just truncates),
but it's the most natural place DP would earn its place here. Naming that
specific landing spot is the honest "here's where the gap would matter" the
spec asks for.

**The 2-D DP table — the shape to drill.** Since DP is the gap, here's the
kernel to rebuild, using edit distance (the canonical first DP):

```
  Edit-distance DP table — the shape to drill (NOT in buffr)

        ""  c  a  t
    "" │ 0  1  2  3      dp[i][j] = min edits to turn first i chars
    c  │ 1  0  1  2                of A into first j chars of B
    a  │ 2  1  0  1
    r  │ 3  2  1  1 ◄─── answer: 1 edit ("cat" → "car")

  each cell = min(left+1, up+1, diag + (chars differ ? 1 : 0))
  fill row by row → bottom-right is the answer. O(m·n) time & space.
```

The load-bearing insight: each cell depends only on three already-computed
neighbours — that's the *optimal substructure + overlapping subproblems* pair
that makes a problem DP-able. Recognising that pair in a new problem is the
skill the drill builds.

### Move 3 — the principle

**DP is the payoff for spotting that a problem reuses its own subproblems.**
The entire technique is: recursion gives you the structure, a cache gives you
the speed, and the only hard part is *recognising* that subproblems overlap. You
already write the recursion (Tree traversals, the river-crossing DFS); the gap
is the recognition step and the memo table. Close that and DP stops being a
separate topic — it's just your recursion, made to remember.

---

## Primary diagram

Recursion/backtracking/DP in buffr — almost entirely the gap map.

```
  Recursion / backtracking / DP — buffr-laptop recap

  PRESENT (lightly):
  ┌─ flat iteration ──────────┐  pg-vector-store.ts:43, eval-cmd.ts:24
  │  for-loops, no recursion   │  (correctly — no recursive structure)
  └────────────────────────────┘
  ┌─ recursive descent (in C) ─┐  files 04, 05
  │  B-tree / HNSW index walks  │  not buffr's source
  └─────────────────────────────┘

  NOT YET EXERCISED (the gaps, ranked):
  ┌─ DYNAMIC PROGRAMMING ★★★ ─┐  highest value — absent in buffr AND portfolio
  │ would land: token-budget    │  session.ts:46 maxTokens — knapsack-shaped
  │ chunk selection, edit dist  │  → drill, file 08
  └─────────────────────────────┘
  ┌─ backtracking ──────────────┐  you built PG.ts (river-crossing) — foundation
  │ no constraint search in buffr│  held, not exercised here
  └──────────────────────────────┘
```

---

## Elaborate

DP (Bellman, 1950s) is the technique with the worst name in CS — "programming"
meant *tabulation*, not coding. The real content is two conditions: *optimal
substructure* (the best answer is built from best answers to subproblems) and
*overlapping subproblems* (those subproblems recur). When both hold, you cache
and win. Edit distance, knapsack, longest-common-subsequence, and matrix-chain
are the canonical four; mastering edit distance gives you the 2-D table pattern
that ~70% of interview DP reduces to.

The honest framing for you: you have the recursion foundation (`Tree.ts`,
`PG.ts`) but not the memoization-as-optimization reflex. That's not a deep
rebuild — it's adding "is there a cache I'm missing?" to recursion you already
write. File `08` ranks it first precisely because the prerequisite (recursion)
is already in your hands.

---

## Interview defense

**Q: Naive recursive Fibonacci is O(2^n). Why, and how does DP fix it?**

```
  naive: fib(n) recomputes fib(n-2) along BOTH fib(n-1) and fib(n) paths
         → same subproblem solved exponentially many times → O(2^n)
  DP:    cache each fib(k) the first time → every later call is O(1)
         → n distinct subproblems, each once → O(n)
```

Answer: the recursion tree has overlapping subproblems — `fib(n-2)` is
recomputed across branches, exponentially. Memoization caches each subproblem's
result so it's computed once; n distinct subproblems → O(n). The part people
forget: DP needs *both* optimal substructure *and* overlapping subproblems —
without overlap, caching buys nothing.

Anchor: *"DP is recursion plus a cache — it only pays off when subproblems
actually overlap."*

**Q: In a RAG system, where would DP earn its place?**

```
  token-budget chunk selection = knapsack
  chunks have (relevance, token-cost); budget = context window (8192)
  maximise total relevance subject to total tokens ≤ budget → DP
       session.ts:46  ContextWindowGuardedProvider({ maxTokens: 8192 })
```

Answer: choosing which retrieved chunks to fit in a fixed context window to
maximise relevance is a knapsack problem — classic DP. buffr currently
truncates instead of optimising, so it's a gap with a concrete landing spot.
(Honest: I'd flag that I haven't built this one — buffr doesn't, and it's on my
drill list — but I can name the reduction.)

Anchor: *"Fixed token budget + per-chunk value and cost is knapsack — DP — and
it's exactly where this system would grow one."*

---

## See also

- `03-stacks-queues-deques-and-heaps.md` — the call stack that backs recursion.
- `05-graphs-and-traversals.md` — backtracking is DFS over a state space; your
  `PG.ts` is the example.
- `08-dsa-foundations-practice-map.md` — DP ranked first in the drill plan,
  with the build steps.

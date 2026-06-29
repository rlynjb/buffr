# Recursion, Backtracking, and Dynamic Programming

**Industry names:** recursion · call stack · backtracking · memoization ·
tabulation · dynamic programming (DP) · overlapping subproblems · optimal
substructure. **Type:** Language-agnostic.

---

## Zoom out, then zoom in

The honest verdict: this is the **biggest gap** in both the repo and your
portfolio. buffr's source has no recursion, no backtracking, and no DP — its
control flow is flat loops over `k=3` hits. Your reincodes work touched
recursion (the `Tree.ts` traversals, the recursive BST insert/delete) and *state-
space search* (`PG.ts` river-crossing via BFS), but classic DP — memoize the
overlapping subproblems, tabulate the bottom-up table — you've only brushed via
recursion-with-memoization. This file teaches the foundation and is blunt about
where it would land if the repo grew into it.

```
  Zoom out — where DP would live (it doesn't, yet)

  ┌─ buffr TS ────────────────────────────────────────────────┐
  │  flat loops: for each query, for each of k hits — no recur │ ← we are here
  │  ★ DP / backtracking: NOT EXERCISED anywhere ★             │
  └──────────────────────────┬─────────────────────────────────┘
                             │  where it COULD appear:
  ┌─ hypothetical future ────▼─────────────────────────────────┐
  │  chunking by token budget (knapsack-flavored) · edit dist  │
  │  on strings · re-ranking with a DP scoring pass            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: **recursion** is a function calling itself, with the call stack as the
implicit state. **Backtracking** is recursion that *undoes* a choice when it
hits a dead end — DFS over a decision tree. **Dynamic programming** is the
optimization for when those recursive subproblems *overlap*: compute each once,
cache it (memoization, top-down) or build a table (tabulation, bottom-up). The
trigger for DP is always the same — *overlapping subproblems + optimal
substructure*. Nothing in buffr has that shape. Yet.

---

## The structure pass

**Layers** — the recursion family by how they handle repeated work:

```
  recursion → backtracking → DP : handling repeated subproblems

  ┌─ plain recursion ─────────────────────┐  recompute everything  O(2ⁿ) risk
  │  Tree.ts traversals (you built this)    │
  └──────────────────────┬──────────────────┘
       ┌─────────────────▼────────────────┐  recurse + prune dead ends
       │ backtracking (DFS over choices)    │  PG.ts state search (adjacent)
       └─────────────────┬────────────────┘
            ┌────────────▼───────────────┐   recurse + CACHE overlaps
            │ dynamic programming          │   ★ not exercised — the real gap
            │ memoize (top-down) / tabulate │
            └──────────────────────────────┘
```

**Axis — state (where does the in-progress work live?).** Trace it: plain
recursion keeps state on the *call stack* (implicit, vanishes on return);
backtracking adds a mutable *choice set* it pushes/pops; DP adds an *explicit
cache/table* that *outlives* a single recursive path. The state moving from
implicit-stack to explicit-table is the whole story of DP.

**Seam — the "do subproblems repeat?" boundary.** This is the seam that decides
whether you need DP at all. If recursive calls hit the *same* subproblem
multiple times (overlapping), caching collapses exponential to polynomial — DP
wins. If every subproblem is unique (like a tree traversal), there's nothing to
cache and plain recursion is correct. buffr has no recursion at all, so it never
reaches this seam — which is exactly why DP is `not yet exercised`.

---

## How it works

### Move 1 — the mental model

You built the recursion foundation: `Tree.ts` pre/post-order with generators,
recursive BST `insert`/`delete`, and `PG.ts` searching a state space. The mental
model for DP is one realization on top of that: **a recursion tree where the same
node appears many times is doing the same work many times — cache it.**

```
  the DP trigger — overlapping subproblems (fib, the canonical case)

  fib(5)
   ├ fib(4)
   │  ├ fib(3)         ← fib(3) computed here
   │  │  ├ fib(2) ...
   │  └ fib(2)
   └ fib(3)            ← fib(3) computed AGAIN — overlap!
      ├ fib(2) ...

  plain recursion: O(2ⁿ) — recomputes fib(3), fib(2)... over and over
  memoized:        O(n)   — compute fib(3) once, cache it, reuse
```

That repeated `fib(3)` is the signal. A cache (memoization) turns the exponential
tree into a linear walk. Tabulation is the same answer built bottom-up: fill
`table[0], table[1], ... table[n]` in order, no recursion. Two roads to one
result.

### Move 2 — the three operations (and why none are in buffr)

**Recursion — present in your reincodes, absent in buffr.** Your `Tree.ts`
traversals are the clean case: each node is visited exactly once, no overlap, so
plain recursion is optimal — no DP needed. buffr's source has none; even the
tree-shaped work (the HNSW graph walk) happens inside Postgres' C, not in
recursive TypeScript.

```
  plain recursion — call stack IS the state (no cache needed when no overlap)

  traverse(node):
    if node is null: return          ── base case: stack unwinds
    visit(node.value)
    for child in node.children:      ── each child once, no repeats
      traverse(child)                ── push frame, recurse, pop on return

  no overlapping subproblems → nothing to memoize → recursion is enough
```

**Backtracking — adjacent in your `PG.ts`, absent in buffr.** Backtracking is
DFS over a *decision* tree: make a choice, recurse, and if it dead-ends, *undo*
the choice and try the next. Your river-crossing puzzle (`PG.ts`, state-space BFS)
is the cousin — it explores a state graph; backtracking is the same exploration
with explicit make/undo and depth-first order.

```
  backtracking — choose, recurse, UNDO on dead end

  solve(state):
    if state is a solution: record it; return
    for choice in legal_moves(state):
      apply(choice)                  ── make the choice (mutate state)
      solve(next_state)              ── recurse deeper
      undo(choice)                   ── ★ BACKTRACK: the part people forget

  drop the undo() → state leaks across branches → wrong answers
```

The undo is the load-bearing part — name it and you've shown you built one.

**Dynamic programming — the real gap, exercised nowhere.** DP needs two
properties together: *overlapping subproblems* (the same subproblem recurs) and
*optimal substructure* (the best answer is built from best answers to
subproblems). When both hold, memoize or tabulate.

```
  the two DP roads — same result, opposite directions

  TOP-DOWN (memoization)            BOTTOM-UP (tabulation)
  ──────────────────────            ──────────────────────
  recurse from the goal             fill a table from the base up
  cache[subproblem] on first solve  table[i] = f(table[i-1], ...)
  lazy: only solves what's needed   eager: solves all subproblems
  cache = hash map (file 02)        table = array (file 02)

  both turn O(2ⁿ) → O(n·states); choose by whether all subproblems are needed
```

Where it would land in *this* repo if it grew: **chunking under a token budget**
is knapsack-flavored (maximize relevant content subject to a size cap —
`ContextWindowGuardedProvider`'s `maxTokens: 8192` in `session.ts:46` is the
budget that would make it a real optimization). **Edit distance** over strings is
the textbook DP if buffr ever did fuzzy id matching. **Re-ranking** retrieved
candidates with a sequence-scoring pass can be DP. None exist today — `not yet
exercised`, and the honest highest-value drill.

### Move 2.5 — current vs future state

```
  Phase A (now): no recursion/DP        Phase B (if it earned its place)
  ──────────────────────────────        ──────────────────────────────
  flat loops over k=3 hits              token-budget chunk selection (knapsack)
  no overlapping subproblems anywhere   memoized re-ranking / edit-distance
  context.md, eval-cmd.ts, session.ts   gated on: corpus + budget pressure
```

DP is absent because the repo has no problem with overlapping subproblems — and
forcing DP where it isn't needed is over-engineering. The honest framing: the
foundation matters for interviews and for the day a token-budget optimization
shows up, not because the current code needs it.

### Move 3 — the principle

DP is recursion plus a cache, and you reach for it *only* when subproblems
overlap and have optimal substructure — otherwise plain recursion (or a loop) is
correct and simpler. The repo has neither property anywhere, so DP is rightly
absent; the skill is recognizing the *trigger*, not applying DP everywhere.

---

## Primary diagram

The recursion family mapped onto what you've built vs the gap.

```
  recursion / backtracking / DP — built, adjacent, gap

  BUILT (reincodes):
   ┌ recursion: Tree.ts traversals, recursive BST insert/delete
   └ state-space search: PG.ts river-crossing (BFS over states)

  ADJACENT (you have the instinct, not the explicit build):
   └ backtracking: DFS + make/undo — PG.ts is the cousin

  GAP — NOT EXERCISED (buffr ⊘, reincodes ⊘):
   ┌ memoization (top-down DP, cache = hash map)
   ┌ tabulation (bottom-up DP, table = array)
   └ classic DP problems (knapsack, edit distance, LIS, coin change) ★ drill
```

---

## Elaborate

Dynamic programming (Bellman, 1950s — the name was deliberately vague to hide
that it was math, the lore goes) is the highest-ceiling topic in interview DSA and
the one most worth deliberate practice, because the pattern transfers: once you
see "overlapping subproblems + optimal substructure → memoize," a huge family of
problems collapses (sequence alignment, shortest paths via Bellman-Ford,
resource allocation, parsing). Its relationship to your existing work is direct:
memoization is just recursion (which you've built) plus a hash map (file 02,
which you use); tabulation is just a loop filling an array (file 02). The
*missing* skill isn't a new structure — it's recognizing the trigger and choosing
top-down vs bottom-up. Backtracking is the sibling for *search* rather than
optimization — DFS with undo — and it's one short step from your `PG.ts` state
search. These are the file-08 drills with the most leverage precisely because
they're absent from both the repo and the portfolio.

---

## Interview defense

**Q: When do you reach for DP instead of plain recursion, concretely?**

```
  test BOTH must hold:
   1. overlapping subproblems — same subproblem solved more than once
      (fib(3) appears twice in fib(5)'s tree)
   2. optimal substructure — best answer built from best sub-answers
  if yes → memoize (cache) or tabulate (table): O(2ⁿ) → O(n·states)
  if no  → plain recursion is correct and simpler (e.g. tree traversal)
```

DP earns its place only when subproblems overlap *and* the problem has optimal
substructure. A tree traversal (my `Tree.ts`) has neither overlap nor an
optimization — so DP there is wrong, plain recursion is right. Naming that DP is
a *conditional* tool, not a default, is the senior signal — most candidates
reach for it reflexively.

**Q: Top-down or bottom-up, and how do you pick?**

```
  top-down (memo):  recurse from goal, cache on demand
                    → use when not all subproblems are needed (sparse)
  bottom-up (tab):  fill table base→goal
                    → use when all subproblems needed; avoids stack depth
```

Top-down memoization is recursion plus a cache — lazy, solves only reachable
subproblems, but risks deep call stacks. Bottom-up tabulation fills an array in
dependency order — eager, no recursion, no stack-overflow risk. Pick bottom-up
when you'll need the whole table anyway and depth is a concern; top-down when the
reachable subproblem set is sparse. Both are "recursion + the right container
from file 02."

**Anchor:** "DP is recursion plus a cache, and only when subproblems overlap —
the repo has no such problem, which is why it's correctly absent. The skill is
spotting the trigger, not applying DP everywhere."

---

## See also

- `02-arrays-strings-and-hash-maps.md` — the cache (hash map) and table (array)
  that DP is built on
- `05-graphs-and-traversals.md` — state-space search (`PG.ts`), the cousin of
  backtracking
- `08-dsa-foundations-practice-map.md` — DP and backtracking are the top-ranked
  drills
- `01-complexity-and-cost-models.md` — the O(2ⁿ) → O(n) collapse memoization buys

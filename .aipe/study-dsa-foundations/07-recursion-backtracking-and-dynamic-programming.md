# Recursion, Backtracking, and Dynamic Programming

**recursion / call stack / backtracking / memoization / tabulation** — *Mostly not yet exercised*

## Zoom out, then zoom in

Honest verdict up front: this is the thinnest file in the guide, because buffr
exercises almost none of it. There's recursion riding the call stack (everywhere,
implicitly), a trace of iteration-budgeted control in the agent loop, and *zero*
dynamic programming or backtracking in buffr's source. That absence is itself the
lesson — so this file teaches the fundamentals and points at where you'd
practice, rather than over-claiming repo evidence.

```
  Zoom out — state-space techniques, by layer (mostly empty)

  ┌─ buffr source layer ─────────────────────────────────┐
  │  recursion: implicit on the JS call stack (free)      │ ← present
  │  backtracking: NONE                                    │ ← gap
  │  dynamic programming: NONE                             │ ← gap
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ aptkit runtime layer ────▼──────────────────────────┐
  │  agent loop: bounded iteration (a flat state machine, │ ← bounded, not
  │              not recursion) — hard step budget         │   recursive
  └───────────────────────────┬──────────────────────────┘
                              │
  ┌─ your reincodes (anchor) ─▼──────────────────────────┐
  │  Tree.ts traversals (recursion + call-stack viz)      │ ← you own recursion
  │  PG.ts river-crossing → BFS over a state graph         │ ← state-space search
  │  (recursion-with-memoization patterns — your baseline) │
  └───────────────────────────────────────────────────────┘
```

Zoom in: **recursion** solves a problem by calling itself on a smaller input,
using the call stack as implicit state. **Backtracking** is recursion that
explores choices and *undoes* them when they dead-end. **Dynamic programming** is
recursion plus a cache (memoization) — or its bottom-up twin, tabulation — for
problems with overlapping subproblems. The question this file answers: *which of
these does buffr actually touch, and which are deliberate gaps to drill?*

## The structure pass

Trace **one axis — "how is intermediate state stored across sub-problems?" —
across the three techniques.**

```
  Axis = "where does the state of sub-problems live?"

  ┌─ plain recursion ──────────────────────┐
  │ state on the CALL STACK, discarded on   │  no reuse
  │ return                                   │
  └──────────────────────┬──────────────────┘
                         │  seam: discard vs undo
  ┌─ backtracking ────────▼────────────────┐
  │ state on the stack, EXPLICITLY UNDONE    │  try → undo → try next
  │ before trying the next choice            │
  └──────────────────────┬──────────────────┘
                         │  seam: recompute vs remember
  ┌─ dynamic programming ─▼────────────────┐
  │ state in a CACHE/TABLE, REUSED across    │  overlapping subproblems
  │ overlapping subproblems                  │  computed once
  └──────────────────────────────────────────┘
```

The load-bearing **seam**: between recursion (state dies on return) and DP (state
is *kept* and reused). DP exists only when subproblems *overlap* — when naive
recursion would recompute the same answer. buffr has no such structure, so it
never crosses this seam. Recognizing "do my subproblems overlap?" is the entire
trigger for reaching for DP — and the honest answer in this repo is no.

## How it works

### Move 1 — the mental model

You own recursion — `Tree.ts` traversals with call-stack visualizers, the
recursive insert/delete in `BinarySearchTree.ts`. The mental model: recursion is
a loop where the *stack* holds your loop variables for you. DP is that same
recursion with a sticky note cache so you never solve the same subproblem twice.

```
  The three shapes — what happens to a subproblem's answer

  RECURSION    f(n) → f(n-1) → f(n-2)        answer used, then discarded
                stack grows, unwinds, gone

  BACKTRACK    try A → dead end → UNDO → try B   explore + reverse
                choose → recurse → un-choose

  DP (memo)    f(n)?  cache hit → return         answer SAVED, reused
                miss → compute → cache → return
```

The single sentence: **recursion forgets, backtracking undoes, DP remembers.**
Which one you need is decided entirely by whether subproblems repeat and whether
choices need reversing.

### Move 2 — each technique against the repo

**Recursion — present, implicit, everywhere.**
Every nested call in buffr rides the JS call stack: JSON serialization of `meta`,
the library's chunk mapping, the agent's internal calls. Bridge: it's the exact
structure your `Tree.ts` visualizers animate — each frame a box on the stack.
Where it breaks: unbounded recursion overflows the stack. buffr never writes deep
recursion in its own source, so it never risks this — but it's why the agent loop
(below) is *iterative*, not recursive.

```
  Call stack as implicit state — recursion (the only form buffr has)

  serialize(meta)
    serialize(meta.foo)        ← push
      serialize(meta.foo.bar)  ← push, deepest
      return                   ← pop
    return                     ← pop
  return                       ← stack empty
       │
       └─ the stack IS the state. buffr leans on this, never hand-rolls it.
```

**Backtracking — absent in buffr; your `PG.ts` is the near-miss.**
Backtracking explores a choice, recurses, and *undoes* the choice on failure —
N-queens, Sudoku, permutation generation. buffr has none. Your reincodes
river-crossing `PG.ts` is the closest thing in your world, but it's BFS over a
state graph (`05`), not backtracking proper — it explores forward with a visited
set, it doesn't undo-and-retry. Bridge: backtracking is DFS that mutates and
reverts shared state; BFS state-space search (what you built) keeps separate
states and never reverts. Where it matters: knowing the difference is the gap —
you've done state-space *search*, not constraint *backtracking*.

```
  Backtracking — choose / recurse / un-choose (NOT in buffr — the gap)

  solve(row):
    for each column c:
      place queen at (row,c)        ← choose
      if safe and solve(row+1):     ← recurse
        return true
      remove queen at (row,c)       ← UN-CHOOSE (the backtrack)
    return false
       │
       └─ the un-choose is the load-bearing part. Your PG.ts BFS has no
          un-choose — it's forward search, not backtracking.
```

**Dynamic programming — fully absent; the cleanest gap in the guide.**
DP applies when subproblems overlap: Fibonacci, edit distance, longest common
subsequence, knapsack, sequence alignment. buffr has *nothing* with overlapping
subproblems — retrieval is a graph walk, chunking is a linear scan, scoring is a
count. Bridge: DP is your recursion-with-memoization, scaled to a table. Where
it's relevant: it isn't, in this repo — and `me.md` flags DP beyond basic
memoization as thin in your portfolio too, so this is a *real* curriculum gap,
not a repo quirk.

```
  DP — memoize overlapping subproblems (NOT in buffr — pure gap)

  fib(5)
   ├ fib(4)
   │  ├ fib(3) ──┐
   │  └ fib(2)   │ fib(3) computed AGAIN here without memo →
   └ fib(3) ◄────┘ overlapping subproblem
       │
       └─ DP caches fib(3) once. buffr has no such overlap anywhere —
          which is precisely why it has no DP. The trigger never fires.
```

#### Move 2.5 — the agent loop: bounded iteration, not recursion

One thing that *looks* like it might recurse but deliberately doesn't: the
aptkit agent loop (consumed by `RagQueryAgent`, built in `src/session.ts`). An agent
that reasons → calls a tool → reasons again is naturally expressible as
recursion, but the library implements it as a *bounded iterative loop* with a hard
step budget — flat state machine, not a growing stack.

```
  Bounded iteration vs the recursion it could have been

  RECURSIVE (rejected):           ITERATIVE (shipped):
  step(state):                    for i in 0..MAX_STEPS:
    if done: return                 if done: break
    return step(next(state))        state = next(state)
       │                                 │
  stack grows per step,           flat — no stack growth,
  overflow risk, no budget        hard cap on iterations
```

Why it matters: a recursive agent loop has no natural ceiling and can blow the
stack or the token budget. The bounded iterative form makes the step budget a
first-class control. This is the closest buffr's stack comes to "recursion as a
design decision" — and the decision was *not* to recurse.

### Move 3 — the principle

**Reach for the technique the subproblem structure demands — and most code
demands none of them.** Recursion when the problem is self-similar; backtracking
when choices must be reversed; DP only when subproblems overlap. buffr's honesty
here is that its problems are linear scans, graph walks, and counts — none with
the overlap or reversal that DP and backtracking exist for. The skill is
recognizing their *absence* as correctly as their presence.

## Primary diagram

The four state-space techniques, mapped to presence/absence in buffr.

```
  State-space techniques across buffr — recap (mostly gaps)

  TECHNIQUE        STATE LIVES        IN BUFFR?         YOUR ANCHOR
  ──────────────────────────────────────────────────────────────────
  recursion        call stack         yes (implicit)    Tree.ts, BST.ts
  bounded iteration flat loop var      yes (agent loop)  — (new pattern)
  backtracking     stack + undo        NO                — (gap; PG.ts is BFS)
  DP (memo/tab)    cache / table       NO                — (real gap)
```

## Implementation in codebase

**Use cases.** Recursion is reached for implicitly on every nested data
structure walk (serializing `meta` jsonb, mapping chunks). The bounded iteration
is reached for on every `npm run chat` turn — the agent reasons and calls tools
in a capped loop. Backtracking and DP are reached for *nowhere*.

```
  src/session.ts  (lines 57, 62) — the bounded agent loop, not recursion

  const agent = new RagQueryAgent({ model, tools, profile, trace });
  const answer = await agent.answer(question);
       │
       └─ inside the library, answer() runs a BOUNDED iterative loop:
          reason → maybe call search_knowledge_base → reason → stop.
          It's a flat state machine with a step ceiling, deliberately NOT
          recursion — no growing call stack, a hard cap on iterations.
          buffr writes zero explicit recursion, backtracking, or DP here.
```

There is no DP or backtracking code to show — and that's the accurate finding.
The only explicit iteration in buffr's own source is the upsert loop:

```
  src/pg-vector-store.ts  (lines 38–43) — flat iteration, no recursion

  for (const c of chunks) this.assertDim(c.vector);   ← flat loop, O(n)
  ...
  for (const c of chunks) { ... await client.query(...) }
       │
       └─ buffr's own logic is flat iteration over arrays — no self-call,
          no stack growth, no memo table. The repo's control flow is linear.
```

## Elaborate

Dynamic programming was named by Bellman in the 1950s (the name was chosen partly
to sound impressive to a skeptical Secretary of Defense — the "dynamic" is mostly
marketing). The real content: optimal substructure + overlapping subproblems.
Backtracking traces to the same era (the term is Lehmer's). Both are recursion
specialized — backtracking adds the undo, DP adds the cache.

For *you* specifically, `me.md` is direct about this: you're strong on recursion
with call-stack visualization and "the classic recursion-with-memoization
patterns," but DP *beyond* that — tabulation, the harder optimization DPs (edit
distance, knapsack, interval DP) — is thin, and backtracking proper hasn't shown
up in your projects. buffr doesn't exercise any of it, so it can't build the
muscle for you. This is the highest-value *curriculum* gap in the guide: it's
absent from both the repo and your portfolio. The drill that closes it is a
classic DP (edit distance or LCS), built bottom-up with a table, with a
visualizer — exactly the format that makes things real for you.

## Interview defense

**Q: Does buffr use dynamic programming anywhere?**

```
  the DP trigger: do subproblems overlap?

  retrieval → graph walk (no overlap)
  chunking  → linear scan (no overlap)
  scoring   → count        (no overlap)
  ──────────────────────────────────────
  no overlap anywhere → no DP. Correct absence.
```

Answer: "No — and that's the right answer, not a gap in the code. DP applies when
subproblems overlap, and buffr's work is a graph walk, a linear chunk scan, and a
count. None overlap. Forcing DP in here would be a solution looking for a
problem." Anchor: the flat iteration in `src/pg-vector-store.ts:38`.

**Q: The agent loop could be recursive. Why isn't it?**

Answer: "An agent that reasons → calls a tool → reasons again is naturally
recursive, but recursion has no natural ceiling — it can grow the stack or the
token budget unbounded. The library implements it as a bounded iterative loop
with a hard step cap, making the budget a first-class control. The decision was
to *not* recurse." Anchor: `src/session.ts:62`.

**Q: You built the river-crossing puzzle. Is that backtracking?**

Answer: "No — it's BFS over a state graph. Backtracking is DFS that mutates shared
state and *undoes* choices on dead ends. My `PG.ts` keeps separate states and uses
a visited set; it explores forward, it never reverts. They're cousins, but the
un-choose step that defines backtracking isn't there." Anchor: reincodes `PG.ts`
vs the N-queens un-choose pattern.

## Validate

1. **Reconstruct.** Write the three-line difference between recursion,
   backtracking, and DP from memory (forgets / undoes / remembers).
2. **Explain.** Why does buffr's agent loop use bounded iteration instead of
   recursion? (`src/session.ts:62` — no unbounded stack/budget.)
3. **Apply.** Name one feature you could add to buffr that *would* justify DP, and
   say why. (E.g. fuzzy chunk-text matching via edit distance — overlapping
   subproblems on substrings.)
4. **Defend.** Argue why the *absence* of backtracking and DP in buffr is correct,
   not a deficiency. (No overlapping subproblems, no reversible choices — the
   triggers never fire.)

## See also

- `05-graphs-and-traversals.md` — the state-space *search* (BFS) that buffr's
  HNSW and your `PG.ts` actually do, vs the backtracking they don't.
- `03-stacks-queues-deques-and-heaps.md` — the call stack recursion rides on.
- `08-dsa-foundations-practice-map.md` — where DP and backtracking rank in your
  practice plan (high — absent from both repo and portfolio).


Updated: 2026-06-24 — purged `npm run ask` / `src/cli/ask-cmd.ts` references; re-grounded the agent loop on `src/session.ts` (built `:57`, invoked `:62`) and the chat entrypoint `src/cli/chat.tsx`; noted `@aptkit/memory` reuses the same HNSW walk (no new DSA).

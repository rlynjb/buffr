# Tree-of-Thoughts

*Industry names: **Tree-of-Thoughts (ToT)** / **deliberate search over reasoning** / **branch-and-evaluate**. Type label: Industry standard. In this codebase: **Not yet implemented — and correctly so.** (buffr runs a single linear path; ToT is rarely worth its cost in production.)*

## Zoom out, then zoom in

This is the top rung of the escalation ladder — and the one to be blunt about. Here is where
it would sit, and why the box is drawn faint.

```
  Where ToT would sit (faint = NOT YET, and probably never for buffr)

  ┌╌ ★ TREE-OF-THOUGHTS (this file) ╌╌╌╌╌╌ 5-15x cost ╌╌╌╌╌╌╌┐
  ╎  branch into N candidate thoughts                        ╎
  ╎  evaluate each · prune · expand the survivors            ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ reflexion (05) · plan-execute (04) ──── also NOT YET ────┐
  ├─ ★ ReAct (buffr) ★ — a SINGLE linear path ── IMPLEMENTED ─┤
  │  run-agent-loop.ts:98-190 — one trajectory, no branching  │
  └────────────────────────────────────────────────────────────┘
```

The verdict up front: **ToT explores multiple reasoning branches in parallel, evaluates
them, and prunes — and it is rarely worth its 5-15x cost in production. buffr runs one
linear path, and that's correct.** This file exists so you can explain *why you didn't* use
it, which is the question that actually comes up.

## Structure pass

One axis: **cost** — how many reasoning paths does one answer pay for?

```
  Axis = COST · paths explored per answer

  ReAct (buffr)        1 path        decide, act, observe, repeat — linear
  reflexion            ~2-5 passes   one path, re-run on critique
  ─────── ★ SEAM: a SINGLE answer now funds MANY parallel paths ★ ───────
  tree-of-thoughts     5-15x         branch × evaluate × prune × expand
```

The seam is the jump from re-running *one* path to exploring *many in parallel*. ToG/ToT
doesn't just retry — it forks the reasoning into N candidates at each step, scores them, and
keeps the best. Every fork is more model calls. For an open-ended search problem (a puzzle,
a proof) that breadth finds answers a linear path misses. For grounded Q&A, it burns 5-15x
the tokens to arrive at the same place.

## How it works

### Move 1 — mental model

ToT turns reasoning from a *path* into a *search over a tree*: generate several candidate
next-thoughts, score them, expand the promising ones, prune the rest. Bridge from frontend:
it's a breadth-first search where each node is a model call, and the heuristic is *another*
model call grading the node.

```
  THE SHAPE — branch, evaluate, prune (the literal tree)

                  ┌── thought A ──▶ score 0.8 ──▶ expand ──▶ ...
   question ──────┼── thought B ──▶ score 0.3 ──▶ PRUNE
                  └── thought C ──▶ score 0.6 ──▶ expand ──▶ ...
                       ▲                              ▲
                       │ N branches per node          │ each expansion = N more calls
                       │ each = a model call           │ → cost compounds
```

### Pseudocode first — the language-agnostic logic

```
frontier = [ question ]
for depth in 0..maxDepth:
    candidates = []
    for node in frontier:
        for i in 0..branchFactor:            # FORK: N thoughts per node
            candidates.append( model.think(node) )    # model call
    scored = [ (c, model.evaluate(c)) for c in candidates ]   # model call PER candidate
    frontier = topK(scored, beamWidth)        # PRUNE to the best few
return best(frontier)
# cost ≈ branchFactor * depth * beamWidth model calls — the 5-15x lives here
```

Annotation: two nested loops of model calls (`think`, then `evaluate`) per depth level. That
double-multiply is why ToT is the most expensive rung — and why it's reserved for problems
where a single path genuinely fails.

### What buffr does instead — and why it's right

buffr explores exactly one path. The model picks one next move per turn; there is no
branching, no candidate scoring, no beam.

```ts
// run-agent-loop.ts:98-135 (condensed) — ONE linear trajectory, no branching
for (let turn = 0; turn < maxTurns; turn += 1) {
  const response = await model.complete({ messages, tools, ... });  // ONE candidate, not N
  messages.push({ role: 'assistant', content: response.content });  // commit to it, no scoring
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }           // linear exit
  // ...execute, accumulate, loop — still ONE path
}
```

```
  buffr (linear)              vs    ToT (tree)

  q → ● → ● → ● → answer            q ─┬─ ● ─┬─ ●  (prune)
      one move per turn,             │  └─ ●  └─ ● → answer
      committed                       └─ ● (prune)
                                      many moves, scored, pruned
```

Annotation: buffr commits to each move and never reconsiders alternatives — one trajectory,
captured in the trace. ToT would fork at every `●`. For buffr's task — retrieve grounded
passages and answer — there is no combinatorial search space that a tree would help explore.
The right answer is in the retrieved chunks; you don't need to *deliberate over branches* to
find it. **buffr correctly doesn't use ToT.**

### Move 3 — the principle

**Tree-of-Thoughts is breadth-first search over reasoning, and you pay one model call per
node — so it's only worth it when a single linear path genuinely cannot find the answer.**
That's puzzles, planning, proofs — problems with a real search space and a cheap evaluator.
Grounded retrieval Q&A is not one of those. The senior move is to recognize ToT as a
specialized tool and *not* reach for it because it sounds sophisticated.

## Primary diagram

Full recap: the tree, the cost, the verdict.

```
  Tree-of-Thoughts — the rung buffr correctly skips

  ┌╌ NOT WORTH IT for buffr ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎ branch (N) × evaluate (per node) × prune × expand        ╎
  ╎ cost: 5-15x   ·  fits: puzzles/planning/proofs           ╎
  ╎ buffr's task: grounded Q&A → NO search space to explore  ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
  ┌─ RUNNING: ONE linear path ──▼────────────────────────────┐
  │ q → ● → ● → answer    run-agent-loop.ts:98-135            │
  └────────────────────────────────────────────────────────────┘
```

Verdict in one line: **ToT is breadth-first search over thoughts at 5-15x cost; buffr's
grounded Q&A has no search space worth a tree, so a single linear path is correct — not a
gap.**

## Elaborate

Tree-of-Thoughts (Yao et al., 2023) beat chain-of-thought on Game-of-24, creative writing,
and mini-crosswords — tasks with a clear branching search space and a usable evaluator. The
production reality is that those conditions are rare: most agent work is retrieval, tool
orchestration, or code, where a linear ReAct path plus good tools wins on cost. ToT's
descendants (Graph-of-Thoughts, beam-search agents) inherit the same cost profile and the
same narrow fit. Knowing *when not to use* a flashy technique is the more valuable signal in
an interview than knowing how it works.

This is the last rung. After this, file `07-routing.md` turns sideways: not "how does the
one model think harder" but "how does control pick between *handlers*" — the bridge from
single-agent reasoning to multi-agent orchestration.

## Interview defense

**Q: "Why doesn't buffr use Tree-of-Thoughts?"**

Model answer: "Because there's no search space worth searching. ToT forks reasoning into N
branches per step, scores each with another model call, and prunes — 5-15x the tokens. It
pays off on puzzles and planning where a single path fails and you have a cheap evaluator.
buffr's task is grounded retrieval Q&A: the answer is in the retrieved chunks, found by one
linear ReAct path (`run-agent-loop.ts:98-135`). There's nothing to deliberate over in a
tree. Using ToT here would be paying 10x to arrive at the same answer — so not using it
isn't a gap, it's the correct call."

```
  The defense in one picture

  search space exists?  ── no ──▶  linear path (buffr) — ToT would just burn tokens
        │ yes (puzzle/plan/proof)
        ▼
  ToT may pay off (5-15x, needs a cheap evaluator)
```

Anchor: *ToT is breadth-first search over thoughts; with no search space, buffr's single
linear path is correct, not a missing feature.*

## See also

- `03-react.md` — the linear floor; the escalation discipline that says "don't climb on spec."
- `05-reflexion-self-critique.md` — the cheaper rung below; also not yet implemented.
- `07-routing.md` — the sideways turn from "think harder" to "pick a handler."
- `../00-overview.md` — lists ToT among the not-yet/design-only patterns.

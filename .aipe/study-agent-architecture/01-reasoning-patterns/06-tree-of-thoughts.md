# Tree of Thoughts — branch, score, pick the best

**Industry name(s):** Tree of Thoughts (ToT) · branch-and-score
reasoning · deliberate search over thoughts. **Type label:** Industry
standard.

**In this codebase: Not yet implemented — and shouldn't be.** buffr
runs one linear ReAct path. ToT multiplies token cost by the branch
factor, and on a local Gemma2:9b answering personal-knowledge
questions, it would buy nothing over a well-prompted single path. This
file exists so you can recognize ToT and say *why you didn't use it* —
which is the more common interview answer.

## Zoom out, then zoom in

ToT is the far end of the reasoning-pattern escalation ladder, and
mostly a place you point at to explain why you stopped earlier.

```
  Zoom out — ToT at the far end of the ladder

  ReAct → plan-and-execute → reflexion → ★ tree-of-thoughts ★
   cheap        ↑                ↑            most expensive,    ← we are here
                └── escalate only on measured failure ──┘ rarely worth it
```

Zoom in: where ReAct commits to one reasoning path, ToT explores
several branches, scores each, and keeps the best. It's deliberate
search over reasoning steps. The cost is the branch factor multiplied
across the depth — which is exactly why it rarely beats a good linear
loop in production.

## Structure pass

**Layers.** A search tree: a root question, branches (candidate
reasoning paths), and a scorer at the leaves. Where ReAct is a line,
ToT is a tree.

**Axis — "cost per answer."** ReAct is one path; ToT is `branches ^
depth` paths. That multiplier is the axis that decides it — it's the
reason ToT is a last resort.

**Seam.** The scoring function. ToT lives or dies on whether you can
cheaply and reliably score a partial reasoning path. If you can't, the
branching is just expensive noise.

## How it works

#### Move 1 — the mental model

You've done BFS over a graph, scoring frontier nodes to decide which
to expand — your `PG.ts` river-crossing search is exactly this shape.
ToT is BFS/DFS where the nodes are *reasoning steps* and the score is
"how promising is this line of thinking."

```
  Pattern — Tree of Thoughts

           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C
          │      │      │
        score  score  score
          └──────┼──────┘
                 ▼
            best path wins
```

#### Move 2 — the walkthrough (why buffr doesn't)

To run ToT in buffr you'd generate several candidate answers (or
candidate search strategies), score each — probably with another model
call — and keep the best. The branch factor multiplies every model
call: 3 branches at depth 2 is ~9x the inference of one linear path.

**The blunt verdict.** For buffr's task — retrieve from a personal
knowledge base and answer — there's no rugged search space that
branching explores better than one well-prompted ReAct loop. The
queries aren't puzzles with many viable solution paths; they're
retrievals. ToT shines on tasks with genuine combinatorial search
(game-of-24, constrained planning), not on "what did my notes say
about X." Add the local-Gemma cost and it's a clear no.

```
  Comparison — buffr's linear path vs ToT

  buffr (linear):              ToT (would-be):
    search → answer              gen 3 strategies
    1 path, capped 4 calls       × score each (3 more calls)
                                 × expand best (3 more)
                                 = ~9x cost, no better answer
```

#### Move 3 — the principle

ToT is the right tool only when the task has a real search space *and*
you can score partial paths cheaply. Most production tasks have
neither. Recognizing that — and choosing the cheaper linear pattern —
is the skill. The senior move is naming why you *didn't* branch.

## Primary diagram

```
  Tree of Thoughts (recognized, not used in buffr)

  root → [path A | path B | path C] → score each → keep best
   cost = branches ^ depth   ← the reason buffr stays linear
```

## Elaborate

ToT (Yao et al., 2023) generalized chain-of-thought into a search:
instead of one chain, explore a tree and use a search algorithm (BFS,
DFS, beam) over thoughts. It's powerful for puzzle-like tasks and
expensive everywhere else. Its honest place in a single-agent guide is
as the ladder's top rung — the thing you escalate to last, if ever.

## Interview defense

**Q: Why not use Tree of Thoughts in buffr?**
Because there's no search space to explore. buffr's tasks are
retrievals, not puzzles with many viable reasoning paths — one
well-prompted ReAct loop covers them. ToT multiplies cost by the
branch factor, which on a local Gemma is wall-clock the user waits
through, for no quality gain. I'd reach for it only on a task with
genuine combinatorial search and a cheap path scorer.

```
  cost = branches ^ depth   |   buffr's tasks: 1 path is enough
```

**Anchor:** "ToT needs a real search space and a cheap scorer —
buffr's retrieval tasks have neither."

## See also

- `03-react.md` — the linear pattern buffr keeps instead
- `04-plan-and-execute.md` · `05-reflexion-self-critique.md` — the
  cheaper escalation rungs to try first

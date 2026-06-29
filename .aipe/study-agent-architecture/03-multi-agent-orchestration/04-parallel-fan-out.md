# Parallel Fan-Out / Fan-In

*Industry names: **fan-out/fan-in** / **parallel agents** / **map-reduce over agents** / **scatter-gather**. Type label: Industry standard. In this codebase: **Not yet implemented.** (buffr is single-agent; nothing runs in parallel.)*

## Zoom out, then zoom in

This is the topology for *independent* work: launch N agents at once, then merge. Here is the
SHAPE first.

```
  THE TOPOLOGY — scatter to N, gather to 1 (★ = the fan points)

                    ┌─ ★ FAN-OUT ─┐
            input ──┤              ├── (all start at once, no waiting on each other)
                    └──┬───┬───┬───┘
                       ▼   ▼   ▼
                  ┌─────┐┌─────┐┌─────┐
                  │AGENT││AGENT││AGENT│   independent · parallel
                  │  A  ││  B  ││  C  │
                  └──┬──┘└──┬──┘└──┬──┘
                     ▼      ▼      ▼
                    ┌─ ★ FAN-IN / MERGE ─┐
                    │ combine A,B,C → 1   │──▶ answer
                    └─────────────────────┘
```

The topology is the mental model: **a diamond — one splits to many, many merge to one.** The
defining requirement is *independence*: the N agents must not need each other's mid-results, or
this isn't a fan-out, it's a chatty pipeline. The honest sentence: buffr runs one agent, in
series with itself; it has no fan-out. This file teaches the shape and the independence test.

## Structure pass

One axis: **failure** — what happens when one of the N parallel agents fails or straggles?

```
  Axis = FAILURE · the SEAM is how the merge handles a missing/slow branch

  all N succeed      → merge sees N results → clean fan-in
  ──────────── ★ SEAM: one branch fails or straggles ★ ──────────
  one branch fails   → merge must DECIDE: drop it? retry? fail the whole run?
  one branch slow    → the whole fan-in waits for the slowest (tail latency)
```

Fan-out's failure model is entirely different from a pipeline's. In a pipeline one failure
halts the line. In a fan-out the *merge* owns the failure policy: it can proceed with N-1
results (`Promise.allSettled` semantics) or fail hard (`Promise.all` semantics). And the
latency is the *slowest* branch, not the sum — fan-out's whole point is that the branches
overlap in time, but that means one straggler sets your latency. That seam — what the merge
does about a missing branch — is the design decision fan-out forces on you.

## How it works

### Move 1 — mental model

`Promise.all()` over independent agents, then a merge function. Bridge from frontend: it's
exactly `await Promise.all([fetchA(), fetchB(), fetchC()])` followed by combining the three
responses into one view — except each fetch is a full agent loop, so each can be slow,
expensive, and individually wrong.

```
  THE SHAPE — Promise.all over agents, then merge

   results = await Promise.all([
     runAgentLoop(agentA, input),   ─┐
     runAgentLoop(agentB, input),    ├─ all in flight AT ONCE
     runAgentLoop(agentC, input),   ─┘
   ])
   answer = merge(results)          ── fan-in: a merge step (often itself a model call)
```

### Fan-out — independent loops in flight at once

Each branch is its own `runAgentLoop`, started without waiting for the others. The wall-clock
cost is the *max* of the branches, not the sum — that's the entire reason to use this topology.

```
  Fan-out — N loops overlap in time

  t0 ─┬─▶ AGENT A ███████░░░░  (returns at t=7)
      ├─▶ AGENT B ████░░░░░░░  (returns at t=4)
      └─▶ AGENT C ██████████░  (returns at t=10) ◀── SLOWEST sets the latency
                              merge waits until t=10, not t=7+4+10
```

```
pseudocode — fan-out (independence is the precondition)
# PRECONDITION: A, B, C do NOT need each other's outputs
results = await Promise.all([
  runAgentLoop(agentA, input),    # e.g. search source 1
  runAgentLoop(agentB, input),    # e.g. search source 2
  runAgentLoop(agentC, input),    # e.g. search source 3
])
```

Annotation: this is the *only* topology where "N independent loops" is the literal truth —
every other multi-agent shape has a dependency DAG with cross-talk. The independence test:
*can branch B start before branch A finishes?* If no, it's not a fan-out.

### Fan-in — the merge owns correctness and failure policy

The merge is where the real engineering lives. It decides how to combine N results *and* what
to do when a branch is missing. The merge is often itself a model call (synthesize N drafts),
which adds its own cost and its own failure mode (synthesis failure — see `09`).

```
  Fan-in — merge decides combination AND failure policy

  [result A]┐
  [result B]┼─▶ MERGE ─┬─ all present? combine → answer
  [ FAILED ]┘          ├─ one missing? proceed with N-1, OR retry, OR fail
                       └─ conflicting? a model call to reconcile (own failure mode)
```

Annotation: a naive merge that assumes all N branches succeed is the most common fan-out bug.
Use `Promise.allSettled` semantics and an explicit policy: proceed-with-partial vs. fail-hard.
The merge is also where cost can blow up — if the merge re-reads every branch's full output
into one model call, you get context bloat (`08`).

### What buffr does instead — strictly serial, one agent

buffr has no fan-out anywhere. Its single agent's tool calls run one at a time inside one loop;
even its multiple searches are sequential turns, not parallel branches.

```
  buffr (today)              vs    fan-out (NOT YET)

  one agent, one loop              input
   search ─▶ search ─▶ answer        ├─▶ agentA ─┐
   (serial turns, never parallel)    ├─▶ agentB ─┼─▶ merge ─▶ answer
                                     └─▶ agentC ─┘
  run-agent-loop.ts:76-202          DESIGN-ONLY
```

Annotation: buffr's failure isn't decomposable into independent specialties — a personal-
knowledge query is one job over one corpus, with nothing to scatter. Fan-out earns its keep
only when you have *genuinely independent* sub-queries (e.g. search three separate corpora, or
ask three different specialists the same question). buffr has neither, so: not yet.

### Move 3 — the principle

**Fan-out trades coordination cost for latency: it's worth it only when the branches are truly
independent, and the merge is where the engineering hides.** Reach for it when you have N
sub-tasks that *don't need each other's mid-results* and you want them to overlap in time.
Don't reach for it when branches are entangled (that's shared state, `08`) — you'd pay the
parallel-coordination cost with none of the parallel benefit. And design the merge's
failure policy up front: partial results vs. fail-hard, plus tail-latency on the slowest
branch.

## Primary diagram

Full recap: the diamond, the independence precondition, the verdict.

```
  Fan-out/fan-in — the diamond and its preconditions

  PRECONDITION: branches are INDEPENDENT (B can start before A finishes)

            ┌─▶ AGENT A ─┐
   input ───┼─▶ AGENT B ─┼─▶ MERGE ─▶ answer
            └─▶ AGENT C ─┘
            (parallel)     (failure policy + tail latency live HERE)

  cost: latency = MAX(branches) · tokens = SUM(branches) + merge
  ───────────────────────────────────────────────────────────────
  buffr: NOT YET · strictly serial · nothing to scatter
  refactor template: SECTION F · parallel-retrieval template
```

Verdict in one line: **the latency topology — only for genuinely independent branches, with the
merge owning failure and cost — and buffr has no independent branches to scatter, so: not
yet.**

## Elaborate

Fan-out/fan-in is the agent-level map-reduce. LangGraph implements it with parallel edges into
a join node; the OpenAI Agents SDK does it by awaiting multiple agents and synthesizing; it's
also the shape of "send the same question to N models and vote" (which overlaps `05`'s debate).
The production lessons are exactly the structure-pass seams: (1) use `allSettled` and an
explicit partial-results policy, because in production one branch *will* fail; (2) your latency
is the slowest branch, so a single slow agent erases the parallelism win; (3) the merge is the
real work and a common cost-blowup site if it naively concatenates all branch outputs.

To adopt fan-out for buffr, see SECTION F's parallel-retrieval template — it shows scattering a
query across multiple corpora as independent loops, then merging the cited chunks.

## Interview defense

**Q: "When would buffr fan out to parallel agents?"**

Model answer: "Only when I have *genuinely independent* branches — the precondition is that
branch B can start before branch A finishes. That'd be something like searching three separate
corpora at once, then merging the cited chunks. It's `Promise.all` over independent
`runAgentLoop`s, and the latency is the slowest branch, not the sum. The real engineering is
the merge: it owns the failure policy — proceed with N-1 via `allSettled`, or fail hard — and
it's where cost blows up if it naively concatenates everything. buffr today is strictly serial
over one corpus (`run-agent-loop.ts:76-202`); a RAG query is one job with nothing to scatter,
so there's no fan-out to justify. If branches needed each other's mid-results, it wouldn't be a
fan-out at all — it'd be entangled shared state."

```
  The defense in one picture

  independent branches? ── no ──▶ NOT a fan-out (it's a pipeline / shared state)
        │ yes
  Promise.all(loops) ─▶ MERGE (failure policy + tail latency live here) ─▶ answer
  buffr: serial, one corpus, nothing to scatter → not yet
```

Anchor: *Fan-out is `Promise.all` over independent agents then a merge; the precondition is
true independence and the engineering is the merge's failure policy — buffr has no independent
branches.*

## See also

- `03-sequential-pipeline.md` — the series case; fan-out is the parallel case of the same
  "compose N loops" idea.
- `05-debate-verifier-critic.md` — "ask N agents the same question and reconcile" is a fan-out
  whose merge is a debate.
- `08-shared-state-and-message-passing.md` — when branches aren't independent, the merge needs
  shared state, and you've left fan-out territory.
- `09-coordination-failure-modes.md` — the merge's synthesis failure and cost-blowup modes.
- `../05-production-serving/` — fan-out backpressure (what changes when the unit is N loops).
- `../06-orchestration-system-design-templates/` (SECTION F) — the parallel-retrieval refactor.

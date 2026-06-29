# Parallel fan-out / fan-in — independent subtasks run at once, a merger combines

**Industry name(s):** parallel fan-out · fan-out/fan-in · map-reduce
agents · scatter-gather. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr runs one agent, one
loop, no parallelism. The trace sink hints at the shape — it queues
writes and awaits them with `Promise.all` (`src/supabase-trace-sink.ts:92`)
— but that's I/O concurrency, not agent fan-out.

## Zoom out, then zoom in — lead with the shape

```
  Parallel fan-out/fan-in topology (lead with it)

           ┌──────── split ────────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │agent 1 │ │agent 2 │  │agent 3 │   (concurrent)
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │ merge agent  │  synthesizes
              └──────────────┘
   latency = the SLOWEST agent, not the sum
```

Zoom in: this is `Promise.all()` over independent requests, then a
reduce. The win is latency — three agents in parallel cost the time of
the slowest, not the sum. The constraint that makes it possible: the
subtasks must be genuinely independent. If one needs another's output,
it's a pipeline, not a fan-out.

## Structure pass

**Layers.** A split, N concurrent workers, a merge. The merge is the
layer that does the reducing.

**Axis — "latency."** Fan-out's whole reason to exist: parallel
workers turn additive latency (pipeline) into max latency (slowest
worker). That's the axis that justifies it.

**Seam.** Two seams: the split (how the task decomposes into
independent parts) and the merge (how results combine). The merge seam
is where contradictory worker outputs must be reconciled — the
synthesis-failure mode in `09-coordination-failure-modes.md`.

## How it works

#### Move 1 — the mental model

You've fired several independent `fetch`es with `Promise.all` and
rendered once they all resolve — you wait for the slowest, not the sum.
Fan-out is that with agents: split into independent sub-questions, run
each agent concurrently, merge.

```
  Pattern — fan-out then fan-in

  task → split into independent sub-tasks
           ▼ (concurrent)
       [agent 1] [agent 2] [agent 3]
           ▼         ▼         ▼
            all results → merge agent → answer
       latency = max(agent_i), not sum
```

#### Move 2 — the walkthrough (what it would take in buffr)

**The independence test is the whole thing.** Fan-out only works if the
sub-tasks don't depend on each other. For buffr, a fan-out-able question
would be "summarize what my notes say about X, Y, and Z" — three
independent retrievals that merge. Each would be a `RagQueryAgent`
search, run concurrently, then a synthesis pass. A question like "refine
my answer about X based on what you found about Y" is *not*
independent — that's a pipeline.

**buffr already has the concurrency primitive, at the I/O layer.** The
trace sink fans out writes and awaits them (`src/supabase-trace-sink.ts:87-93`):

```ts
private push(p: Promise<void>): void { this.pending.push(p); }
async flush(): Promise<void> { await Promise.all(this.pending); }
```

That's the exact `Promise.all` shape an agent fan-out would use — but
applied to DB writes, not agent runs. The mechanical leap to agent
fan-out is small; the hard part is the *split* and *merge* logic, not
the concurrency.

**The cost fan-out introduces: backpressure.** Three concurrent agents
is three concurrent Gemma calls hitting one Ollama instance. A
supervisor that fans out faster than the provider can serve needs a
concurrency cap — the fan-out-backpressure concern in
`05-production-serving/02-fan-out-backpressure.md`. For local Gemma,
unbounded fan-out would just queue at Ollama and lose the latency win.

```
  Comparison — pipeline vs fan-out for a 3-part question

  pipeline (serial):              fan-out (parallel):
    A → B → C                       [A | B | C] → merge
    latency = A + B + C             latency = max(A,B,C) + merge
    (use when dependent)            (use when independent)
```

#### Move 3 — the principle

Fan-out trades additive latency for max latency — but only when the
subtasks are genuinely independent. The constraint *is* the pattern: no
subtask may need another's output. buffr has the concurrency primitive
already (at the I/O layer) and would need only split/merge logic plus a
concurrency cap to apply it at the agent layer — if it ever had a
genuinely parallel question, which today it doesn't.

## Primary diagram

```
  Parallel fan-out (would-be in buffr)

  "summarize notes on X, Y, Z" → split
       ┌──────────┬──────────┐
       ▼          ▼          ▼
   search(X)   search(Y)   search(Z)   ← concurrent RagQueryAgents
       └──────────┼──────────┘             (capped concurrency)
                  ▼
            merge agent → combined answer
   latency = slowest search + merge
```

## Elaborate

Fan-out is supervisor-worker with the workers in parallel — the
supervisor's "decompose" produces independent sub-tasks and its
"synthesize" is the merge. It's the topology behind the multi-agent
research assistant (`06-...templates/01-multi-agent-research-assistant.md`):
parallel retrieval from many sources, synthesized with citations. Its
production hazards — backpressure on fan-out, lost-in-the-middle across
many worker results — are in
`05-production-serving/02-fan-out-backpressure.md` and the
coordination-failure-modes file.

## Interview defense

**Q: Could buffr parallelize?**
At the agent layer, only for genuinely independent sub-questions — e.g.
"summarize my notes on X, Y, and Z" splits into three concurrent
retrievals that merge. It already has the `Promise.all` concurrency
primitive at the I/O layer (the trace sink's `flush`), so the leap is
small; the work is the split/merge logic plus a concurrency cap so it
doesn't overwhelm the local Ollama. Today buffr has no parallel
question, so it stays serial.

```
  independent subtasks → Promise.all(agents) → merge
  latency = slowest, not sum
```

**Anchor:** "Fan-out is `Promise.all` over agents — only valid when no
subtask needs another's output."

## See also

- `02-supervisor-worker.md` — fan-out is its parallel form
- `03-sequential-pipeline.md` — the serial alternative for dependent
  stages
- `05-production-serving/02-fan-out-backpressure.md` — the concurrency
  cap fan-out needs
- `09-coordination-failure-modes.md` — the merge/synthesis failure

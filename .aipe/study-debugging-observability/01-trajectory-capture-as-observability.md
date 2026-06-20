# Trajectory capture as observability

**Industry names:** agent trajectory / conversation log / execution trace.
**Type:** Project-specific (the trace-store-as-side-effect-of-memory shape).

## Zoom out, then zoom in

You know how a `fetch()` has loading / success / error states, and if you want to
debug it you log each transition? buffr does that for an *agent run* — except the
log isn't a logger, it's a database table that already existed for a different
reason. The `agents.messages` table was built to remember conversation turns. It
also happens to be the only place a run's behavior is recorded. Trajectory capture
*is* the observability.

```
  Zoom out — where the trace store lives

  ┌─ CLI layer (src/cli/ask-cmd.ts) ─────────────────────────────┐
  │  agent.answer(question)  →  prints answer to stdout          │
  └───────────────────────────┬──────────────────────────────────┘
                              │  CapabilityEvent stream
  ┌─ Agent loop (aptkit-core) ▼──────────────────────────────────┐
  │  step · tool_call_* · model_usage · warning · error          │
  └───────────────────────────┬──────────────────────────────────┘
                              │  emit() → persistMessage()
  ┌─ Storage layer ───────────▼──────────────────────────────────┐
  │  ★ agents.messages ★   role · content · tool_results · model │ ← we are here
  │  (conversation memory AND the trace store, same rows)        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **persist-the-trajectory**. As the agent loop runs, it
emits events. A sink turns the events it cares about into rows. After the run, those
rows are both the conversation history (memory for next time) and the trace (evidence
for debugging this time). One table, two jobs.

## Structure pass

**Layers.** Three nested levels produce this trace: the *loop* (emits events), the
*sink* (selects + queues writes), the *table* (durable rows).

**Axis — trace `who decides what gets recorded?` down the layers.**

```
  "who decides what gets recorded?" — one question, three answers

  ┌──────────────────────────────────────┐
  │ loop: emits ALL 6 event types        │   → the loop decides what HAPPENED
  └───────────────────┬──────────────────┘
        ┌─────────────────────────────────┐
        │ sink: keeps 2 of 6 (step, tool) │   → the SINK decides what's RECORDED
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ table: stores rows as-is │   → the table decides NOTHING (dumb store)
              └──────────────────────────┘

  the answer flips at the sink — that's the load-bearing seam
```

**Seam.** The load-bearing boundary is `loop → sink`. The loop's contract is "I emit
everything that happened." The sink's contract is "I record what I think matters."
The axis flips here: upstream, completeness is guaranteed; downstream, it's a
*choice*, and buffr's choice is lossy (it keeps 2 of 6 event types). Study this seam
before the table internals — the table only ever holds what the seam let through.
The dropped four event types are the subject of `02-discarded-trace-signal.md`; this
file walks what the seam *does* let through.

## How it works

### Move 1 — the mental model

The shape is a **selecting sink draining an event stream into rows**. Picture an
event stream flowing past a filter that lets two shapes through and writes each as a
row:

```
  the selecting sink — stream in, rows out

  events:  [step] [tool_start] [tool_end] [model_usage] [step] [warn]
              │         ✗           │           ✗          │       ✗
              ▼                     ▼                       ▼
           assistant              tool                  assistant      ← only these
              row                  row                     row           become rows
              └──────────────── into agents.messages ───────────────┘
```

The kernel: an `emit(event)` that branches on `event.type`, builds a row for the
shapes it recognizes, and pushes the write *promise* onto a pending list — then a
`flush()` that awaits them all after the run. Synchronous emit, deferred await.

### Move 2 — the walkthrough

**The sync-emit / async-write split.** This is the part that trips people. aptkit's
`CapabilityTraceSink` contract says `emit(event): void` — synchronous, no `await`.
But writing a row is async (a DB round-trip). You can't `await` inside a `void`
method. So the sink does the only correct thing: it *starts* the write and stashes
the promise, returning immediately.

```
  emit() must return now; the write finishes later

  emit(event):                          pending: [ ───── ]
     row = buildRow(event)
     pending.push( persistMessage(row) )    ← fire, don't await
     return                                  ← sync contract satisfied

  ... loop keeps running, emit() called again and again ...

  flush():  await Promise.all(pending)   ← drain everything after the run
```

What breaks if you remove the `pending` list: emit would either block (violating the
sync contract, stalling the loop) or fire-and-forget with no way to know the writes
finished — the CLI would `pool.end()` and exit mid-write, losing the tail of the
trace. The pending list is the load-bearing part.

**The type branch — what becomes a row.** The sink recognizes two event shapes:

```
  event.type branch — pseudocode

  on emit(event):
    if event.type == 'step' and event.role == 'assistant' and event.content:
        write row { role: 'assistant', content: event.content }   // the model's text
    else if event.type == 'tool_call_end':
        write row { role: 'tool', content: event.toolName,
                    tool_results: event.result }                  // the tool's output
    // every other event type: ignored, no row
```

The `event.content` truthiness check on the `step` branch matters: an assistant turn
with no text (a pure tool-call turn) emits a `step` with empty content, and you do
*not* want an empty assistant row for it. So the guard is correct. The flip side —
the final-answer edge case — is the boundary condition below.

**The boundary: does the final answer get a row?** This is the question worth
nailing. Trace it:

```
  final-answer persistence — the loop's last turn

  model returns content with NO tool_uses          ← terminal turn
        │
        ├─ text = textFromContent(content)
        ├─ if text:  emit step{role:assistant, content:text}   ← row IS written
        ├─ finalText = text
        └─ break
                │
                ▼
  agent returns:  finalText.trim() || FALLBACK_ANSWER
```

So: when the model produces a real final answer, `text` is truthy, the `step` fires,
and **the answer is persisted** — through the same step branch as any other
assistant turn. But when the model returns empty and the agent substitutes
`FALLBACK_ANSWER` ("I couldn't find anything…"), no `step` fired for it, so **the
fallback the user sees is never recorded.** The trace store and the user's screen
disagree exactly in the failure case. That's the load-bearing gap in this pattern.

### Move 3 — the principle

A side-effect trace store is free and honest right up until you ask it a question it
wasn't designed to answer. `messages` answers "what was the conversation?" perfectly
because that's its job. It answers "what went wrong on the failed run?" poorly,
because recording failures was never the design intent — the sink only learned to
write the turns memory needs. The principle: *when observability is a side effect of
another mechanism, its blind spots are wherever the two purposes diverge.* Memory
cares about successful turns; debugging cares about failures. They diverge at the
fallback, the dropped error event, and the missing timing.

## Primary diagram

The full path, one frame, every layer labelled.

```
  trajectory capture — full path for one `ask` run

  ┌─ CLI (src/cli/ask-cmd.ts) ───────────────────────────────────────┐
  │  startConversation() → conversationId                            │
  │  persistMessage(user, question)            ← user row, explicit  │
  │  agent.answer(question)                                          │
  │  trace.flush()  → pool.end() → stdout.write(answer)              │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ CapabilityEvent stream
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────────┐
  │  emit(step.assistant)   → push persistMessage(assistant, content)│
  │  emit(tool_call_end)    → push persistMessage(tool, name, result)│
  │  emit(everything else)  → dropped                                │
  │  flush() → await Promise.all(pending)                            │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ insert (created_at = now())
  ┌─ agents.messages ─────────▼──────────────────────────────────────┐
  │  user row · assistant row(s) · tool row(s)                       │
  │  = conversation memory  AND  the run's trace                     │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for once per `ask` run. Triggered by `npm run ask -- "..."`.
It solves two things at once here: (1) conversation memory — future turns can read
prior rows for the same `conversation_id`; (2) post-hoc debugging — after a weird
answer you `psql` into `agents.messages` and read the assistant/tool rows to see what
the agent did. There's no third consumer yet (no UI replays it, no eval reads it).

**The sink — `src/supabase-trace-sink.ts:23-40`.**

```
  src/supabase-trace-sink.ts  (lines 27–39)

  emit(event: CapabilityEvent): void {
    const { pool, conversationId } = this.opts;
    if (event.type === 'step' && event.role === 'assistant' && event.content) {
        this.pending.push(                              ← fire, don't await
          persistMessage(pool, conversationId, 'assistant', event.content));
    } else if (event.type === 'tool_call_end') {
        this.pending.push(
          persistMessage(pool, conversationId, 'tool', event.toolName,
            { toolResults: event.result }));            ← keep result, drop durationMs
    }
  }                                                     ← all other types: no branch

  async flush(): Promise<void> {
    await Promise.all(this.pending);                    ← drain after the run
  }
       │
       └─ pending list is load-bearing: without it, emit can't satisfy the
          sync void contract AND still guarantee the writes complete before
          ask-cmd.ts calls pool.end(). Drop it → lose the tail of every trace.
```

**The row writer — `src/supabase-trace-sink.ts:10-19`.**

```
  src/supabase-trace-sink.ts  (lines 10–19)

  persistMessage(pool, conversationId, role, content, extra?) {
    insert into agents.messages
      (conversation_id, role, content, tool_results, model)
      values ($1, $2, $3, $4, $5)
  }
       │
       └─ note what's NOT in the column list: no created_at (defaults to now()),
          no tokens_used, no durationMs. The write shape itself is where the
          timing/cost evidence is lost — see 02 and 03.
```

**The explicit user row — `src/cli/ask-cmd.ts:29-30`.** The one row the sink does
*not* write. The CLI inserts the user's question directly before the agent runs,
because no `CapabilityEvent` represents the user's original prompt — the loop only
emits what *it* does, not what was asked of it.

```
  src/cli/ask-cmd.ts  (lines 29–35)

  const conversationId = await startConversation(pool, cfg.appId);
  await persistMessage(pool, conversationId, 'user', question);   ← user row, by hand
  const trace = new SupabaseTraceSink({ pool, conversationId });
  const agent = new RagQueryAgent({ model, tools, profile, trace });
  const answer = await agent.answer(question);
  await trace.flush();                                            ← drain before exit
       │
       └─ flush() before pool.end() (line 38) is mandatory: end the pool first
          and the pending writes error out against a closed pool.
```

## Elaborate

This pattern comes straight out of agent frameworks treating the message list as the
unit of both memory and audit — the same array you replay to the model is the array
you inspect to debug. buffr's twist is durability: instead of an in-memory array, the
trajectory lands in Postgres, so it survives the process. That's the right call for a
"second brain" — you want yesterday's conversations back. The cost is that the *trace*
inherits the *memory* schema, and memory doesn't care about durations, token counts,
or errors. The adjacent concepts: the event source (the agent loop) lives in
`study-agent-architecture`; the schema design of `messages` lives in
`study-data-modeling`; the thing the sink throws away is the whole of
`02-discarded-trace-signal.md`; the ordering fragility is `03`.

## Interview defense

**Q: Your trace store is a conversation-memory table. What's the load-bearing risk
in reusing one table for both?**
The blind spots land wherever the two purposes diverge. Memory only needs successful
turns; debugging needs failures. So my fallback answer — `finalText || FALLBACK_ANSWER`
— is shown to the user but never written, because no `step` event fires for the
substituted text. The user sees an answer the trace store has no record of. Naming
that specific divergence is the signal that I've actually traced the path.

```
  the divergence that bites

  user screen:   "I couldn't find anything..."  (FALLBACK_ANSWER)
  messages table: (no assistant row for it)     ← step never fired on empty text
                  └─ memory's needs ≠ debugging's needs, exactly here
```

**Q: Why is `emit` synchronous but the write async, and how do you not lose writes?**
The sink contract is `emit(event): void` — I can't `await` a DB round-trip in a void
method without either blocking the loop or breaking the contract. So I fire the write
and push the promise onto a pending list, then `await Promise.all(pending)` in a
separate `flush()` the CLI calls before `pool.end()`. Drop the pending list and the
process exits mid-write, truncating the trace.

## Validate

1. **Reconstruct.** From memory, write the `emit` branch: which two of the six event
   types become rows, and what role each gets. (`src/supabase-trace-sink.ts:27-35`.)
2. **Explain.** Why does `ask-cmd.ts` write the `user` row by hand instead of letting
   the sink do it? (`src/cli/ask-cmd.ts:30` — no event represents the user prompt.)
3. **Apply.** A user reports a wrong answer from last Tuesday. Walk exactly which
   rows you'd read from `agents.messages`, and name the one piece of the agent's
   behavior those rows can't tell you. (Answer: the search query — `tool_call_start`
   args are dropped, `src/supabase-trace-sink.ts`.)
4. **Defend.** Someone proposes moving the trace to a separate `traces` table so
   memory and debugging stop sharing a schema. Argue for or against, and name the one
   gap it would and wouldn't fix. (Fixes: timing/error columns without polluting
   memory. Doesn't fix on its own: the `created_at` ordering bug — see `03`.)

## See also

- `02-discarded-trace-signal.md` — the four event types this sink drops.
- `03-created-at-replay-ordering-gap.md` — why replaying these rows can scramble.
- `04-stdout-as-only-log.md` — the other half of buffr's evidence: the CLI prints.
- `../study-agent-architecture/` — where the `CapabilityEvent` stream is produced.
- `../study-data-modeling/` — the `agents.messages` schema design.

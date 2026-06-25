# Trajectory capture as observability

**Industry names:** agent trajectory / conversation log / execution trace.
**Type:** Project-specific (the trace-store-as-side-effect-of-memory shape).

> Updated: 2026-06-24 — `ask-cmd.ts` is gone; the run is now driven by the long-lived
> `src/session.ts` behind the `npm run chat` Ink TUI (`src/cli/chat.tsx`). The sink now
> records all six event types (see `02`), so the trajectory is complete — this file
> still teaches the side-effect-trace shape, regrounded on the current files.

## Zoom out, then zoom in

You know how a `fetch()` has loading / success / error states, and if you want to
debug it you log each transition? buffr does that for an *agent run* — except the
log isn't a logger, it's a database table that already existed for a different
reason. The `agents.messages` table was built to remember conversation turns. It
also happens to be the only place a run's behavior is recorded. Trajectory capture
*is* the observability.

```
  Zoom out — where the trace store lives

  ┌─ CLI layer (src/cli/chat.tsx → src/session.ts) ──────────────┐
  │  session.ask(question)  →  renders answer in the Ink TUI     │
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
        │ sink: records ALL 6 faithfully  │   → the SINK decides what's RECORDED
        └─────────────┬───────────────────┘
              ┌──────────────────────────┐
              │ table: stores rows as-is │   → the table decides NOTHING (dumb store)
              └──────────────────────────┘

  the seam is still load-bearing — it just no longer narrows the stream
```

**Seam.** The load-bearing boundary is `loop → sink`. The loop's contract is "I emit
everything that happened." The sink's contract is "I record what matters" — and as of
2026-06-24 it records all six event types, so completeness is now preserved across the
seam rather than narrowed at it (that's the `02` reframe). Study this seam before the
table internals — the table only ever holds what the seam let through. The remaining
divergence isn't *which event types* survive (all do) but the one place memory's needs
and debugging's needs still split: the `FALLBACK_ANSWER` edge below, where the user
sees text no `step` event ever fired for.

## How it works

### Move 1 — the mental model

The shape is a **selecting sink draining an event stream into rows**. Picture an
event stream flowing past a filter that lets two shapes through and writes each as a
row:

```
  the recording sink — stream in, one row per event

  events:  [step] [tool_start] [tool_end] [model_usage] [step] [warn]
              │         │           │           │          │      │
              ▼         ▼           ▼           ▼          ▼      ▼
          assistant  tool_call    tool      model_usage  asst.  warning
             row       row         row         row        row    row
              └──────────────── into agents.messages ───────────────┘
```

The kernel: an `emit(event)` that switches on `event.type`, builds a row for *every*
variant of the union, and pushes the write *promise* onto a pending list — then a
`flush()` that awaits them all after the turn. Synchronous emit, deferred await.

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

**The type switch — what becomes a row.** The sink dispatches on `event.type` and
builds a row for every variant (the full set is the subject of `02`):

```
  event.type switch — pseudocode

  on emit(event):
    at = event.timestamp                         // stamped for ordering, see 03
    switch event.type:
      'step':            if event.content:
                            write row { role: event.role, content }   // model's text
      'tool_call_start': write row { role: 'tool_call', tool_calls: {name, args} }
      'tool_call_end':   write row { role: 'tool', tool_results: {result, error, durationMs} }
      'model_usage':     write row { role: 'model_usage', model, tokens_used }
      'warning'|'error': write row { role: event.type, content: event.message }
```

The `event.content` truthiness check on the `step` branch matters: an assistant turn
with no text (a pure tool-call turn) emits a `step` with empty content, and you do
*not* want an empty assistant row for it. So the guard is correct. Note `role` now
comes from `event.role` rather than a hardcoded `'assistant'`, so a user-role step
would persist with its own role. The flip side — the final-answer edge case — is the
boundary condition below.

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
because that's its job. It used to answer "what went wrong on the failed run?" poorly,
because recording failures wasn't the original design intent — but the 2026-06-24 sink
rewrite added the `error`/`warning`/`durationMs` branches, so debugging's needs are now
served too (see `02`). The principle still holds: *when observability is a side effect
of another mechanism, its blind spots are wherever the two purposes diverge.* The one
divergence that survives the rewrite is the `FALLBACK_ANSWER`: memory only records text
a `step` event fired for, and the substituted fallback fires no event — so the user
sees an answer the trace store has no row for.

## Primary diagram

The full path, one frame, every layer labelled.

```
  trajectory capture — full path for one chat turn

  ┌─ session.ask() (src/session.ts) ─────────────────────────────────┐
  │  startConversation() → conversationId  (once, at session start)  │
  │  persistMessage(user, question)            ← user row, explicit  │
  │  agent.answer(question)                                          │
  │  trace.flush()  → memory.remember() → return answer to the TUI   │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ CapabilityEvent stream
  ┌─ SupabaseTraceSink ───────▼──────────────────────────────────────┐
  │  emit(step)            → push persistMessage(role, content)      │
  │  emit(tool_call_start) → push persistMessage(tool_call, args)    │
  │  emit(tool_call_end)   → push persistMessage(tool, result/dur)   │
  │  emit(model_usage)     → push persistMessage(model_usage, tokens)│
  │  emit(warning|error)   → push persistMessage(type, message)      │
  │  flush() → await Promise.all(pending)                            │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ insert (created_at = event.timestamp ?? now())
  ┌─ agents.messages ─────────▼──────────────────────────────────────┐
  │  user · assistant · tool_call · tool · model_usage · warning rows│
  │  = conversation memory  AND  the run's complete trace            │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for once per turn inside the long-lived chat session, started by
`npm run chat`. It solves two things at once here: (1) conversation memory — future
turns can read prior rows for the same `conversation_id`, and the session also embeds
each exchange as retrievable episodic memory via `@aptkit/memory` (`session.ts:53,67`);
(2) post-hoc debugging — after a weird answer you `psql` into `agents.messages` and read
the turn rows to see what the agent did, now including args, durations, tokens, and
errors. There's no third consumer yet (no UI replays it, no eval reads it).

**The sink — `src/supabase-trace-sink.ts:53-93`.**

```
  src/supabase-trace-sink.ts  (lines 56–84, abridged)

  emit(event: CapabilityEvent): void {
    const at = event.timestamp;
    switch (event.type) {
      case 'step':            if (content) push(persist(event.role, content, {createdAt: at}));
      case 'tool_call_start': push(persist('tool_call', toolName, {toolCalls:{name,args}, ...}));
      case 'tool_call_end':   push(persist('tool', toolName, {toolResults:{result,error,durationMs}}));
      case 'model_usage':     push(persist('model_usage', '', {model, tokensUsed: in+out, ...}));
      case 'warning': case 'error': push(persist(event.type, event.message, {createdAt: at}));
    }
  }                                                     ← every union variant has a branch

  async flush(): Promise<void> {
    await Promise.all(this.pending);                    ← drain after the turn
  }
       │
       └─ pending list is load-bearing: without it, emit can't satisfy the
          sync void contract AND still guarantee the writes complete before
          session.ask() returns / close() ends the pool. Drop it → lose the tail.
```

**The row writer — `src/supabase-trace-sink.ts:19-37`.**

```
  src/supabase-trace-sink.ts  (lines 27–36)

  persistMessage(pool, conversationId, role, content, extra?) {
    insert into agents.messages
      (conversation_id, role, content, tool_calls, tool_results, model,
       tokens_used, created_at)
      values ($1..$7, coalesce($8::timestamptz, now()))
  }
       │
       └─ the column list now carries tool_calls + tokens_used + created_at,
          so timing/cost/cause all have a home — the evidence the old write
          shape lost is now persisted. See 02 (full signal) and 03 (created_at).
```

**The explicit user row — `src/session.ts:60-61`.** The one row the sink does *not*
write. The session inserts the user's question directly before the agent runs, because
no `CapabilityEvent` represents the user's original prompt — the loop only emits what
*it* does, not what was asked of it.

```
  src/session.ts  (lines 55–67)

  const conversationId = await startConversation(pool, cfg.appId);   ← once per session
  const trace = new SupabaseTraceSink({ pool, conversationId });
  const agent = new RagQueryAgent({ model, tools, profile, trace });
  async ask(question) {
    await persistMessage(pool, conversationId, 'user', question);    ← user row, by hand
    const answer = await agent.answer(question);
    await trace.flush();                                             ← drain per turn
    try { await memory.remember({ conversationId, question, answer }); } catch {}
    return answer;
  }
       │
       └─ flush() before the pool is closed in close() is mandatory: end the pool
          first and the pending writes error out against a closed pool. The
          conversation is held across every turn — not reopened per call.
```

## Elaborate

This pattern comes straight out of agent frameworks treating the message list as the
unit of both memory and audit — the same array you replay to the model is the array
you inspect to debug. buffr's twist is durability: instead of an in-memory array, the
trajectory lands in Postgres, so it survives the process. That's the right call for a
"second brain" — you want yesterday's conversations back. The cost *used* to be that
the trace inherited the memory schema and memory didn't care about durations, token
counts, or errors — but the schema grew `tool_calls`/`tokens_used` columns and the sink
grew the branches to fill them, so the trace now carries that signal too (`02`). The
adjacent concepts: the event source (the agent loop) lives in
`study-agent-architecture`; the schema design of `messages` lives in
`study-data-modeling`; the full event signal the sink now records is the whole of
`02-discarded-trace-signal.md`; the client-timestamp replay ordering is `03`.

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
separate `flush()` the session calls after each `ask()`, before `close()` ends the pool.
Drop the pending list and the process exits mid-write, truncating the trace.

## Validate

1. **Reconstruct.** From memory, write the `emit` switch: which row each of the six
   event types becomes, and what role each gets. (`src/supabase-trace-sink.ts:56-84`.)
2. **Explain.** Why does `session.ts` write the `user` row by hand instead of letting
   the sink do it? (`src/session.ts:61` — no event represents the user prompt.)
3. **Apply.** A user reports a wrong answer from last Tuesday. Walk exactly which
   rows you'd read from `agents.messages`, and name what the agent's behavior those
   rows now *can* tell you that they couldn't before. (The search query — `tool_call`
   row's `tool_calls.args`, now captured at `src/supabase-trace-sink.ts:62-65`.)
4. **Defend.** Someone proposes moving the trace to a separate `traces` table so
   memory and debugging stop sharing a schema. Argue for or against, and name the one
   gap it would and wouldn't fix. (Doesn't need it now: the shared schema already grew
   timing/cost/error columns. Wouldn't fix on its own: the `FALLBACK_ANSWER` divergence
   — no event fires for it — see Move 3.)

## See also

- `02-discarded-trace-signal.md` — the full event signal this sink now records.
- `03-created-at-replay-ordering-gap.md` — how the persisted event timestamp orders these rows.
- `04-stdout-as-only-log.md` — the other half of buffr's evidence: the CLI/TUI prints.
- `../study-agent-architecture/` — where the `CapabilityEvent` stream is produced.
- `../study-data-modeling/` — the `agents.messages` schema design.

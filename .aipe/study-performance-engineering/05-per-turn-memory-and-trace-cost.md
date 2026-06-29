# Per-Turn Memory & Trace Cost — the write amplification of one chat turn

**Industry name(s):** write amplification; trace fan-out; full-signal trajectory capture. **Type:** Industry standard.

One question from the user produces one answer — and around that answer, a fan-out of database writes: the user message, up to six trace events, and an extra embed-plus-insert for episodic memory. None of it dominates the turn. All of it is real.

## Zoom out, then zoom in

A chat turn isn't just "embed, search, generate." It's also *recording* what happened — for replay, for observability, and for the memory that resurfaces past exchanges. That recording is writes, and there are more of them than the one answer suggests.

```
  Zoom out — the write fan-out of one ask()

  ┌─ Session.ask (src/session.ts:60) ────────────────────────────┐
  │  1. persistMessage(user)        →  1 INSERT                   │
  │  2. agent.answer(question)      →  embed + HNSW + GENERATE    │ ◄ gemma2:9b
  │     │                              (trace events QUEUED here) │   DOMINATES
  │  3. trace.flush()               →  up to 6 INSERTs  ★         │ ← we are here
  │  4. memory.remember()           →  1 embed + 1 INSERT  ★      │ ← and here
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Postgres + Ollama ───────▼───────────────────────────────────┐
  │  ~8 DB writes + 1 extra embed roundtrip, per turn             │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **write amplification** — one logical event (a turn) producing many physical writes. Two sources: the trace sink fans one turn out to six event-type INSERTs, and `memory.remember` adds a second embed roundtrip plus another INSERT on top of the answer.

## The structure pass

Axis: **cost** — physical writes (and model calls) per logical turn.

```
  axis = "writes + model calls per turn"

  ┌─ logical: one Q&A turn ─────────────┐   → 1 conceptually
  └─────────────────┬────────────────────┘
  ┌─ physical fan-out ▼──────────────────┐   ═══ THE AMPLIFICATION ═══
  │  user INSERT            → 1           │   one turn becomes
  │  trace: step/tool_start/tool_end/    │   ~8 DB writes
  │         model_usage/warning/error    │   + 1 extra embed
  │                         → up to 6     │   (a 2nd MODEL call)
  │  memory: embed + INSERT → 1 + 1       │
  └─────────────────┬────────────────────┘   ← seam: 1 → ~8 + 1 embed
  ┌─ Postgres + Ollama ▼─────────────────┐
  └───────────────────────────────────────┘
```

**Seam:** the boundary between the answer the user sees and the record kept around it. On the answer side, one logical exchange. On the record side, it fans out to ~8 writes and a second model call. The amplification factor is the finding.

## How it works

### Move 1 — the mental model

You know how a single user action in an event-sourced system writes one row to the UI but appends *several* events to the log — created, validated, applied? Same shape. One `ask()` produces one answer for the user and a spray of audit writes behind it. The twist buffr adds: one of those behind-the-scenes steps (`memory.remember`) isn't just a write — it's a *second embedding roundtrip*, the only part of the fan-out that touches a model.

```
  one turn → fan-out of records

  ask(question)
     │
     ├─ user INSERT ─────────────► messages
     ├─ [agent runs: embed, search, GENERATE] ── the big cost
     ├─ trace.flush ──┬─ step ───► messages
     │                ├─ tool_call_start ─► messages
     │                ├─ tool_call_end ───► messages
     │                ├─ model_usage ─────► messages
     │                └─ warning/error ───► messages   (up to 6)
     └─ memory.remember ─ embed(Q+A) ─► INSERT ─► chunks  ← 2nd model call
```

### Move 2 — the step-by-step walkthrough

**The turn sequence.** `src/session.ts:60-71` is the whole fan-out:

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // write 1
  const answer = await agent.answer(question);                   // the BIG cost
  await trace.flush();                                           // writes 2..7
  try {
    await memory.remember({ conversationId, question, answer }); // embed + write 8
  } catch { /* best-effort: don't lose the answer */ }
  return answer;
}
```

**The trace fan-out — queued during, flushed after.** The clever part: `SupabaseTraceSink.emit()` is *synchronous* (aptkit's contract requires it) but the writes are async. So `emit()` *queues* a promise and `flush()` awaits them together (`src/supabase-trace-sink.ts:53-93`). The six `CapabilityEvent` types each map to a `persistMessage`:

```ts
switch (event.type) {
  case 'step':            /* assistant content */    // → messages
  case 'tool_call_start': /* tool name + args */     // → messages (the cause)
  case 'tool_call_end':   /* result + durationMs */  // → messages (timing!)
  case 'model_usage':     /* model + tokensUsed */   // → messages (tokens!)
  case 'warning':
  case 'error':           /* message */              // → messages
}
```

Named by what breaks if removed:
- **the queue-then-flush split** (`push` at `:87`, `Promise.all` at `:92`) — without it, every event would block the agent run serially on a DB write. With it, the writes *overlap* the run and resolve together at the end. This is the part that keeps the fan-out off the critical path — the writes race the pool rather than stalling generation. Load-bearing, and a good choice.
- **`durationMs` (`:69`) and `tokensUsed` (`:76`)** — these are the *measurement* payload. They're captured here and, per the audit, never read back. The capture is right; the loop that aggregates them is the missing piece (audit lens 2). This is where the highest-leverage fix lives.

**The memory cost — the only extra model call.** `memory.remember` (`src/session.ts:66`) embeds the question+answer into the *same* vector store tagged `kind=memory`, so future turns resurface it via the existing search tool. The performance fact: this is a *second* embedding roundtrip to Ollama on every turn, on top of the query embed inside `answer()`. It's wrapped in try/catch (`:65-69`) so a memory failure never loses the user's answer — best-effort, correct.

```
  the two model calls per turn

  answer():        embed(query) ──► HNSW ──► gemma2:9b GENERATE  ◄ dominant
  memory.remember: embed(Q + A) ──► INSERT chunks               ◄ extra, cheap
                   ▲ second roundtrip to Ollama, but an embed,
                     not a generate — small next to the GENERATE
```

**Does it matter at laptop scale?** No — and here's the honest accounting. The ~7 INSERTs are localhost Postgres writes, low single-digit milliseconds, overlapped via `flush()`. The one part that touches a model — `memory.remember`'s embed — is an *embedding* call, not a generation call, so it's a fraction of the `gemma2:9b` step that already dominates the turn. The whole fan-out is rounding error next to generation. It's deprioritized correctly. The reason it earns a file anyway: the `durationMs`/`tokens` capture *in* this fan-out is the instrumentation that, if read back, would turn every estimate in this guide into a number.

### Move 3 — the principle

Recording a turn costs more writes than answering it — and that's usually fine, as long as the recording stays off the critical path. buffr keeps it off-path two ways: the trace queues-then-flushes so writes overlap the run, and memory is best-effort so its failure can't cost the answer. The general lesson: write amplification is acceptable when (a) the writes are cheap relative to the dominant cost and (b) they don't block the thing the user is waiting on. buffr satisfies both. The unfinished half is reading the captured timing back.

## Primary diagram

```
  Per-turn write amplification — one ask(), the full fan-out

  ┌─ Session.ask (src/session.ts:60-71) ─────────────────────────┐
  │  persistMessage(user) ───────────────────────► messages [1]  │
  │  agent.answer() ── embed → HNSW → GENERATE ── gemma2:9b ◄DOMIN│
  │     │  (trace events emit()'d sync, QUEUED as promises)       │
  │  trace.flush() ── Promise.all(pending) ──┐                    │
  │     ├ step ───────────────────────────────┼─► messages        │
  │     ├ tool_call_start (args) ─────────────┤                   │
  │     ├ tool_call_end (durationMs) ─────────┤   ← timing captured│
  │     ├ model_usage (tokensUsed) ───────────┤   ← tokens captured│
  │     └ warning / error ────────────────────┘   (up to 6) [2..7]│
  │  memory.remember() ── embed(Q+A) → INSERT ─► chunks [8]       │
  │     ▲ 2nd Ollama roundtrip (embed, not generate) · try/catch  │
  └───────────────────────────────────────────────────────────────┘
   total: ~8 DB writes + 1 extra embed · all dwarfed by GENERATE
```

## Elaborate

The full-signal trace capture is deliberate — the schema comment and the sink's docstring (`src/supabase-trace-sink.ts:39-48`) call out that tool-call args, `durationMs`, token usage, and warning/error events used to be "dropped on the floor," and capturing all six event types turns `agents.messages` into a complete, replayable trajectory. The `created_at` from the event timestamp (`:26`, `:30`) preserves emit order against the race of concurrent flush inserts — a correctness detail with a performance flavour (it's why `Promise.all` is safe to fire unordered).

For the retrieval-based episodic memory shape — why `remember` writes into the same store and how recall works — see **`study-ai-engineering`** (memory / MemoRAG). For the trace-as-observability angle (what these events are *for*), see **`study-debugging-observability`**. For the unbounded `Promise.all` as a latent backpressure question, see `audit.md` lens 6. This file owns the *write-amplification cost* read.

## Interview defense

**Q: What does one chat turn actually cost in writes?**

> More than the one answer suggests. A turn is the user INSERT, then up to six trace INSERTs — one per `CapabilityEvent` type: step, tool-call start and end, model usage, warning, error — then an embed-plus-insert for episodic memory. So roughly eight DB writes and one extra embedding roundtrip per turn. But it's all dwarfed by `gemma2:9b` generation, and I keep it off the critical path: the trace queues writes during the run and flushes them together, and memory is best-effort in a try/catch so its failure can't cost the answer.

```
  one turn → ~8 writes + 1 extra embed
  trace: emit() sync → queue → flush Promise.all (overlaps the run)
  memory: best-effort, try/catch (failure ≠ lost answer)
```

**Q: Is any of that a problem?**

> Not at laptop scale — localhost writes are milliseconds and they overlap the run, and the one model call in the fan-out is an *embed*, not a generate, so it's small next to the generation that already dominates. The real value buried in there is the instrumentation: I capture `durationMs` and token counts per event but don't read them back yet. Closing that — one aggregation over `agents.messages` — is the highest-leverage perf move I have, because right now every "is it slow" answer is an estimate.

> Anchor: `src/session.ts:60-71` (the fan-out), `src/supabase-trace-sink.ts:53-93` (six events, queue-then-flush, captured timing).

## See also

- `00-overview.md` — finding #4 and finding #6 (the unread instrumentation)
- `audit.md` — lens 2 (measurement gap), lens 5 (I/O), lens 6 (backpressure)
- `02-embedding-roundtrip.md` — the embed `memory.remember` repeats
- `04-connection-pool-reuse.md` — the pool all these writes share
- **`study-ai-engineering`** — episodic memory / MemoRAG
- **`study-debugging-observability`** — the trace as observability

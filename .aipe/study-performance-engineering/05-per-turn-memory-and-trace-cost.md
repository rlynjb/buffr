# Per-Turn Memory and Trace Cost

**Industry names:** write amplification · observability overhead · full-signal trajectory
capture · retrieval-based episodic memory. **Type:** Project-specific (the shape is general:
fixed per-turn write cost).

---

## Zoom out, then zoom in

Every chat turn does more writing than the answer itself requires. On top of generating the
reply, buffr embeds-and-stores the whole exchange as episodic memory, and the trace sink
fans the agent's trajectory out into several INSERTs — one per event type. None of it is
free, and none of it is on the critical path of *answering*. This file measures that
per-turn write tax and asks the only question that matters: does it cost the user anything.

```
  Zoom out — the extra writes hanging off one turn

  ┌─ Session layer (src/session.ts) ask() ─────────────────────────────┐
  │  persistMessage(user)        ← 1 INSERT (the question)              │
  │  agent.answer(question)      ← gemma2 generation (THE big cost)     │
  │  trace.flush()               ← ★ up to 6 event types → INSERTs ★    │ ← we are here
  │  memory.remember(exchange)   ← ★ extra EMBED + extra UPSERT ★       │
  └──────────────────────────────────┬─────────────────────────────────┘
            embed │ HTTP                 │ pg wire (warm pool)
  ┌─ Ollama ─────▼──────┐   ┌─ Postgres ▼──────────────────────────────┐
  │ nomic-embed (again) │   │ agents.messages (trace)  agents.chunks   │
  └─────────────────────┘   │ (memory, kind=memory)                    │
                            └───────────────────────────────────────────┘
```

Zoom in: two patterns stacked on each turn — **retrieval-based episodic memory** (an extra
embed+upsert so past exchanges resurface later) and **write-amplified trajectory capture**
(the trace sink turns one agent run into many rows). The question: what's the per-turn tax,
and is it visible next to gemma2.

---

## Structure pass

**Layers.** Two write sources beyond the answer: the trace sink
(`supabase-trace-sink.ts:53-85`) and the memory engine (`session.ts:66`). Both ride the same
warm pool from `04`.

**Axis — cost (writes incurred per turn that aren't the answer).** Hold "how many writes does
one turn incur beyond storing the reply?":

```
  One question — "writes per turn beyond the answer itself?" —

  ┌─ the answer path ───────────────────────────────────┐
  │  persistMessage(user) + persistMessage(assistant)    │  required
  └──────────────────────────────────────────────────────┘
  ┌─ trace sink (observability) ────────────────────────┐
  │  step / tool_call_start / tool_call_end /            │  ≥1 INSERT per event type,
  │  model_usage / warning / error  → INSERT each        │  one row per occurrence
  └──────────────────────────────────────────────────────┘
  ┌─ memory engine (episodic recall) ───────────────────┐
  │  embed(exchange) [HTTP] + upsert(memory chunk) [SQL] │  an EXTRA embed + write
  └──────────────────────────────────────────────────────┘

  the answer is 1-2 writes; observability + memory multiply that into many.
```

**Seam — `trace.flush()` and the `try/catch` around `remember`.** Two load-bearing seams:
the trace sink is *sync emit, async flush* (events queue during the run, all writes awaited
after — `trace-sink.ts:53,91-93`), and `memory.remember` is wrapped best-effort
(`session.ts:65-69`) so a memory-write failure can't lose the answer the user already has.
Both seams keep the extra cost *off* the answer's critical path.

---

## How it works

### Move 1 — the mental model

You know how adding analytics to a request — log this, increment that counter, fire an event
— quietly multiplies the writes per request even though the user only asked for one thing?
That's write amplification. buffr has two sources of it per turn: a trace sink that records
*everything the agent did* (for replay), and a memory write that embeds the exchange so it
can resurface later. The strategy: **do the extra writes, but keep them off the critical path
— queue the trace and flush after; make memory best-effort.**

```
  One turn — write amplification, mapped

  user asks ──► [persist user]                          1 write
            ──► agent.answer() ──► gemma2 (the cost) ──► (trace events queue during run)
            ──► trace.flush() ──► [step][tool_start]    ──► many writes
                                  [tool_end][usage]...
            ──► memory.remember ─► [embed] + [upsert]    ──► 1 extra embed + 1 write

  amplification factor: 1 question → ~1 embed + several-to-many INSERTs
```

### Move 2 — the walkthrough

**The trace sink — sync emit, queued, flushed after.** `supabase-trace-sink.ts:53-93`:

```ts
emit(event: CapabilityEvent): void {          // ← SYNC (aptkit's contract); can't await here
  switch (event.type) {
    case 'step':            this.push(persistMessage(... event.content ...)); return;
    case 'tool_call_start': this.push(persistMessage(... args ...)); return;   // the cause
    case 'tool_call_end':   this.push(persistMessage(... result, error,
                                       durationMs ...)); return;               // ← timing!
    case 'model_usage':     this.push(persistMessage(... tokensUsed ...)); return; // ← tokens!
    case 'warning':
    case 'error':           this.push(persistMessage(... event.message ...)); return;
  }
}
private push(p) { this.pending.push(p); }     // ← queue, don't await
async flush() { await Promise.all(this.pending); }  // ← all writes awaited AFTER the run
```

Six event variants, each becoming its own `persistMessage` INSERT. A turn with one tool call
emits roughly: step(s) + tool_call_start + tool_call_end + model_usage = four-plus rows, then
`flush()` (`session.ts:64`) awaits them all. The design keeps emit *sync* (aptkit requires it)
and defers the actual DB work to `flush`, so the inserts don't block the agent mid-run —
they happen in one `Promise.all` burst after the answer is ready.

**The captured-but-unread baseline — the honest gap.** Look at what `tool_call_end` and
`model_usage` persist: `durationMs` (line 69) and `tokensUsed` (line 76). buffr writes
per-call latency and per-call token counts to `agents.messages` *every single turn* — and
nothing ever reads them back. There's no aggregation query, no p50/p95, no token-cost report.
The baseline is being *generated and discarded into a table nobody selects from*. This is the
cheapest performance win in the whole repo (see `audit.md` §2): the instrument is installed;
the dial just isn't read.

**The memory write — an extra embed + upsert, best-effort.** `session.ts:60-71`:

```ts
async ask(question) {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);    // ← gemma2 (the dominant cost)
  await trace.flush();                            // ← the trace burst above
  try {
    await memory.remember({ conversationId, question, answer });  // ← EXTRA embed + upsert
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
  return answer;
}
```

`memory.remember` (aptkit's engine, buffr's store) embeds the question+answer exchange — a
*second* Ollama HTTP call this turn, on top of the query embed — and upserts it as a
`kind=memory` chunk into the same `agents.chunks` table. That's how past exchanges resurface
later through the same `search_knowledge_base` tool (retrieval-based episodic memory). The
`try/catch` is load-bearing: a memory-write failure must not lose the answer the user already
has, so it's swallowed deliberately.

**The load-bearing skeleton — what breaks if you remove each part:**

```
  per-turn write tax — name each part by what breaks without it

  1. trace.flush() after run    remove → trajectory lost; durationMs/tokens never persisted
  2. sync emit / async push     make emit await → blocks the agent mid-run (breaks contract)
  3. memory.remember            remove → no cross-turn episodic recall; agent forgets
  4. try/catch around remember  remove → a memory-write failure throws away a good answer
  ── the cost ──
  5. 6-event-type fan-out       this IS the write amplification — one run → many rows
  6. extra embed for memory     this is the per-turn second embed (HTTP + GPU)
```

**Does it matter at laptop scale? No.** Add it up: one extra embed call and several INSERTs
over a warm local pool. The embed is tens-to-hundreds of milliseconds; the INSERTs are
single-digit. Next to `gemma2:9b` generation — *seconds* — the entire per-turn write tax is
rounding error. The design *correctly* spends cheap writes to buy replay-grade observability
and cross-session memory. The only thing left on the table isn't the write cost — it's the
*read* cost that's never paid: nobody queries the latency/token data being written.

### Move 3 — the principle

Observability and memory both buy real capability — replayable trajectories, recall across
sessions — at the price of write amplification. The discipline is twofold: keep the extra
writes off the critical path (queue + flush, best-effort + swallow), and *close the loop* by
reading back what you measure. buffr does the first perfectly and skips the second — it
instruments durationMs and tokens, then never looks at them.

---

## Primary diagram

```
  Per-turn memory and trace cost — the full write tax of one ask()

  ┌─ ask() (src/session.ts) ──────────────────────────────────────────┐
  │  persist user            → 1 INSERT                                │
  │  agent.answer()          → gemma2 generation  (DOMINATES, seconds) │
  │    │ during run, trace.emit() queues events (sync, no await)       │
  │  trace.flush()           → Promise.all([                           │
  │      step, tool_call_start, tool_call_end(durationMs←),            │
  │      model_usage(tokensUsed←), warning?, error? ])  → many INSERTs │
  │  memory.remember() [try] → embed exchange (HTTP) + upsert chunk    │
  │                            (kind=memory)            → 1 embed+1 SQL │
  └──────────────────────────────────┬────────────────────────────────┘
       embed │ HTTP :11434              │ pg wire (warm pool, see 04)
  ┌─ Ollama ▼──────────┐   ┌─ Postgres ▼──────────────────────────────┐
  │ nomic-embed (2nd   │   │ agents.messages: trajectory rows         │
  │ embed this turn)   │   │   durationMs + tokens_used ← WRITTEN,     │
  └────────────────────┘   │   never read back (the open loop)        │
                           │ agents.chunks: kind=memory chunk         │
                           └───────────────────────────────────────────┘
```

---

## Elaborate

Two general patterns meet here. Write amplification is the observability tax — every metric,
log, and trace event you add multiplies per-request writes; the art is keeping it async and
off the critical path, which the sync-emit/async-flush split does. Retrieval-based episodic
memory is the cheaper alternative to stuffing full conversation history into the prompt: you
embed each exchange and *retrieve* the relevant ones later, instead of carrying all of them
forward. buffr uses retrieval-based memory precisely because `RagQueryAgent.answer()` treats
each question independently (noted at `session.ts:25-27`) — relevance-based recall gives
cross-turn memory without sequential in-prompt history.

The captured-but-unread `durationMs`/`tokens_used` is the thread connecting this file to the
whole guide: it's the baseline that `audit.md` §2 says is missing, sitting in the database
waiting for a `SELECT`. Closing that loop is the natural next move.

---

## Interview defense

**Q: What does a chat turn cost beyond generating the answer?**

Two extra write sources. The trace sink turns the agent's run into several INSERTs — one per
`CapabilityEvent` type (step, tool_call_start/end, model_usage, warning, error), capturing
`durationMs` and token usage for replay. And `memory.remember` does an *extra* embed of the
exchange plus an upsert, so past turns resurface later via the same retrieval tool.

```
  1 question → ~1 extra embed + several INSERTs (trace) + 1 upsert (memory)
  all of it dwarfed by gemma2 generation (seconds)
```

Two things I'd point out. First, it's kept off the critical path: trace emit is sync but the
DB writes are queued and flushed *after* the run, and the memory write is best-effort in a
`try/catch` so it can't lose a good answer. Second — the honest gap — I *write* durationMs
and tokens every turn and never read them back. The baseline is in the table; I just haven't
written the `SELECT`. That's the cheapest perf win I have, and it's a read I'm not doing.

**Anchor:** `supabase-trace-sink.ts:53-93` (trace fan-out), `session.ts:60-71` (memory write,
best-effort).

---

## See also

- `02-embedding-roundtrip.md` — the memory write is a *second* embed roundtrip per turn.
- `04-connection-pool-reuse.md` — all these extra writes run cheap over the warm pool.
- `06-no-caching.md` — the per-turn embeds (query + memory) are recomputed, never cached.
- `audit.md` §2 (the unread baseline), §5, §6 (unbounded flush buffer), §8 (red flags #3, #6).
- `study-debugging-observability` — the trace/trajectory side of this same mechanism.

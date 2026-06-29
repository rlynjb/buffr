# Trajectory tables (full-signal agent log)

**Industry name(s):** event log / agent trajectory capture — here the
trajectory tables (`conversations` + `messages`) plus episodic memory riding
`chunks`. **Type:** Industry standard (append-only event/trajectory log),
shipped full-signal.

---

## Zoom out, then zoom in

You know an event log: an append-only table where each row is one thing that
happened, in order, so you can replay or audit later. This file is about the two
tables that record *everything the agent did* on each turn — not just the
assistant's text, but every tool call's arguments, every result, every model's
token count, every warning and error — and how a second form of memory
(episodic recall) rides the `chunks` table instead.

```
  Zoom out — where the trajectory is written

  ┌─ agent run (aptkit RagQueryAgent) ───────────────────────┐
  │  emits CapabilityEvents: step · tool_call_start ·         │
  │  tool_call_end · model_usage · warning · error            │ ← source
  └───────────────────────────────┬───────────────────────────┘
                                  │  SupabaseTraceSink.emit (sync)
  ┌─ persistence (app) ───────────▼───────────────────────────┐
  │  every event → persistMessage(...)  ── queued, flushed     │ ← here
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ Postgres (agents schema) ────▼───────────────────────────┐
  │  conversations (1 per session)                            │
  │     └─FK→ messages (1 per event, full-signal columns)     │
  │  chunks (meta.kind='memory')  ── episodic recall, separate │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "what does the database remember about a turn, and in
what order?" The answer is two things. The **trajectory** — the complete
event-by-event record in `messages`, ordered by the event timestamp so replay
matches emit order. And the **episodic memory** — a *different* memory that
embeds past exchanges into `chunks` so they resurface by relevance through the
same retrieval tool. Two memories, two storage shapes, one design.

---

## The structure pass

```
  One axis: "how is a past turn recalled?"

  ┌─ trajectory (conversations → messages) ──────────────────┐
  │  recall = read rows in created_at order                  │  by ORDER
  │  full-signal: tool args, results, tokens, errors         │  (replay)
  └─────────────────────────┬────────────────────────────────┘
                            │  seam: the OTHER memory recalls differently
  ┌─ episodic memory (chunks, meta.kind='memory') ───────────┐
  │  recall = embed query, ANN search, top-k                 │  by RELEVANCE
  │  rides the SAME vector column + HNSW index                │  (retrieval)
  └──────────────────────────────────────────────────────────┘
```

The axis is **how a past turn is recalled**, and it flips cleanly across the two
stores. The `messages` log is recalled by *order* — read the rows by
`created_at` and you replay exactly what happened. The episodic memory in
`chunks` is recalled by *relevance* — embed the new question, ANN-search, get
the most similar past exchanges back regardless of when they happened. Same
underlying conversation; two storage shapes because the two recall modes need
different access paths. That flip is the load-bearing distinction.

---

## How it works

### Move 1 — the mental model

Think of two ways your app remembers a user's history. A `console.log` stream
(or a Redux action log) — chronological, complete, you scroll it in order. And a
search box over past content — you type a query and the most relevant past items
surface, order-independent. The trajectory tables are the first; episodic memory
is the second. Same raw history, two indexes into it, because "what happened
next" and "what's relevant now" are different questions.

```
  Two memories over one conversation

  TRAJECTORY (messages)          EPISODIC (chunks, kind=memory)
  ─────────────────────          ──────────────────────────────
  ordered by created_at          ordered by embedding distance
  read sequentially → replay     embed query → top-k by relevance
  rows: every event              rows: past exchanges, embedded
  recall question: "then what?"  recall question: "what's like now?"
```

### Move 2 — the walkthrough

**One conversation row, the only real FK in the schema.** Each session inserts
one `conversations` row (`supabase-trace-sink.ts:4-7`, `startConversation`), and
every message points at it via the schema's single enforced foreign key:

```sql
-- sql/001_agents_schema.sql:40-50
create table if not exists agents.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agents.conversations(id) on delete cascade,  // ← the ONE FK
  role text not null,
  content text not null default '',
  tool_calls jsonb,        // populated — tool args (the cause)
  tool_results jsonb,      // populated — result, error, durationMs
  model text,              // populated — "provider/model"
  tokens_used int,         // populated — input + output tokens
  created_at timestamptz not null default now()   // overridden by event timestamp
);
```

`on delete cascade` means deleting a conversation deletes its whole trajectory —
the right cascade for a log that's meaningless without its parent. This is the
one place the repo *wants* the database to enforce the relationship (contrast
`03-soft-link-no-fk.md`, where it deliberately doesn't), and it's a clean fit.

**Full-signal capture — every event variant becomes a row.** The trace sink
maps *all six* `CapabilityEvent` types to message rows, not just assistant text.
The comment in the sink is explicit that tool args, durations, errors, and token
usage were "previously dropped on the floor" and are now captured
(`supabase-trace-sink.ts:42-48`). The dispatch:

```ts
// supabase-trace-sink.ts:53-84 (condensed)
emit(event: CapabilityEvent): void {
  const at = event.timestamp;                    // event's own timestamp
  switch (event.type) {
    case 'step':                                  // assistant/user text
      if (event.content) this.push(persistMessage(pool, conv, event.role, event.content, { createdAt: at }));
      return;
    case 'tool_call_start':                       // the CAUSE — tool name + args
      this.push(persistMessage(pool, conv, 'tool_call', event.toolName, {
        toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));
      return;
    case 'tool_call_end':                         // the EFFECT — result, error, duration
      this.push(persistMessage(pool, conv, 'tool', event.toolName, {
        toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
      return;
    case 'model_usage':                           // fills the tokens_used column
      this.push(persistMessage(pool, conv, 'model_usage', '', {
        model: `${event.provider}/${event.model}`,
        tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
      return;
    case 'warning': case 'error':                 // operational events, not just happy path
      this.push(persistMessage(pool, conv, event.type, event.message, { createdAt: at }));
      return;
  }
}
```

Every branch produces a `messages` row, so the table holds the *complete* turn:
the tool call (cause) and its result (effect) as separate rows, the model's
token usage, and any warnings/errors — not a sanitized "assistant said X"
summary. That's what "full-signal" means and it's why `tokens_used` and
`tool_calls`/`tool_results` are populated, not orphaned columns.

**`created_at` comes from the event, not server `now()` — for deterministic
replay order.** This is the subtle, load-bearing part. `emit()` is synchronous
(aptkit's contract), but the writes are *queued* and flushed concurrently after
the run (`push` / `flush`, `:87-93`). Concurrent inserts race — if `created_at`
defaulted to `now()`, two events emitted in order could land with reversed
timestamps depending on which insert won the race. So the sink threads each
event's *own* timestamp into `created_at`:

```ts
// supabase-trace-sink.ts:26-36 (persistMessage)
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages (... created_at)
   values ($1, ..., coalesce($8::timestamptz, now()))`,   // ← event ts, else now()
  [..., createdAt],
);
```

`coalesce($8, now())` uses the event timestamp when present, falling back to
server `now()` only if the event didn't carry one. The result: ordering by
`created_at` replays the trajectory in *emit* order, immune to the flush race.

```
  Why event-timestamp, not now() — the flush race

  emit order:   step₁  tool_call₂  tool_end₃   (synchronous, in order)
                  │        │           │
                  ▼        ▼           ▼  queued, flushed CONCURRENTLY
  insert race:  could commit in ANY order
                  │
  if created_at = now():   3, 1, 2  ✗ replay order wrong
  if created_at = event ts: 1, 2, 3 ✅ replay = emit order
```

**Episodic memory rides `chunks`, not `messages`.** The *second* memory is
separate. After each turn, `memory.remember({ conversationId, question, answer })`
(`session.ts:67`) embeds the exchange and writes it into the *same vector store*
as a chunk tagged `meta.kind='memory'`, id `"memory:<conv>:<n>"`. It recalls by
relevance through the existing `search_knowledge_base` tool — so a past exchange
resurfaces when it's semantically similar to the new question, across sessions.
It's best-effort: a memory-write failure is swallowed so it can't lose the answer
the user already has (`session.ts:64-69`). This is why `chunks` is overloaded
(`01`, `03`): episodic memory needs the ANN access path, and `messages` is
ordered-replay, so they live in different tables on purpose.

**The boundary condition — the trajectory write is best-effort and non-atomic
with the user turn.** The user question is persisted up front
(`session.ts:61`), then the agent runs, then `trace.flush()` writes the
trajectory (`session.ts:63`). If `flush()` partially fails, you can get a turn
with the user message but an incomplete trajectory. For a personal log that's an
acceptable cost — the answer still reached the user — but it means the
`messages` log is a *best-effort* record, not a transactional guarantee. Name it.

### Move 3 — the principle

An event log's value is that it's *complete and ordered* — capture only the
happy path and you can't debug the failure; capture out of order and you can't
replay. This repo gets both right: full-signal (every event variant, cause and
effect, tokens and errors) and event-timestamped ordering (replay matches emit,
immune to the flush race). And it recognizes that "remember in order" and
"remember by relevance" are different access patterns that earn different
storage — ordered rows in `messages`, embedded chunks in `chunks`. The general
lesson: match the *storage shape* to the *recall question*, and never let a
concurrency detail (the flush race) silently corrupt the one property
(ordering) the log exists to provide.

---

## Primary diagram

```
  Trajectory + episodic memory — two memories, two shapes

  ┌─ agent run ───────────────────────────────────────────────┐
  │  CapabilityEvents (6 types, with timestamps)               │
  └──────────────┬───────────────────────────┬─────────────────┘
                 │ SupabaseTraceSink.emit     │ memory.remember
                 │ (queued → flush)           │ (best-effort)
                 ▼                            ▼
  ┌─ conversations ─┐  FK    ┌─ chunks (meta.kind='memory') ───┐
  │ id uuid PK      │◄───────│ id "memory:<conv>:<n>"          │
  └────────┬────────┘ cascade│ embedding vector(768) + HNSW    │
           │                 │ recall: ANN by RELEVANCE        │
           ▼                 └─────────────────────────────────┘
  ┌─ messages ────────────────────────────────────────────────┐
  │ conversation_id FK · role · content                       │
  │ tool_calls · tool_results · model · tokens_used  (POPULATED)│
  │ created_at = EVENT timestamp  ── replay = emit order       │
  │ recall: read rows by created_at (ORDER)                    │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Full-signal trajectory capture is what separates a toy agent from a debuggable
one. When an agent gives a wrong answer, the question is always "what did it
*do*?" — which tool did it call, with what args, what came back, did a step
error. A log that only stores the final assistant text can't answer that; this
one can, because it stores the cause (`tool_call_start` args) and the effect
(`tool_call_end` result/error/duration) as distinct rows. The `tokens_used`
capture turns the same log into a cost ledger.

The deterministic-ordering trick — deriving `created_at` from the event rather
than the insert — is the kind of detail that only shows up once you've been
burned by a concurrent log writing rows out of order. It's a small line
(`coalesce($8, now())`) carrying a real correctness property. The
observability/replay treatment of this log lives in
**study-debugging-observability**; the storage-engine view of MVCC behind the
concurrent flush lives in **study-database-systems**. Here the lesson is the
*schema shape*: one FK'd parent, full-signal child rows, event-ordered.

---

## Interview defense

**Q: Why does `created_at` come from the event timestamp instead of `now()`?**
Because the writes are queued and flushed concurrently after the run
(`supabase-trace-sink.ts:87-93`), so insert order races. If `created_at`
defaulted to `now()`, two events emitted in order could persist with reversed
timestamps and replay would be wrong. Threading the event's own timestamp into
`created_at` via `coalesce($8, now())` (`:30`) makes "order by created_at" replay
the trajectory in emit order, immune to the race. That's the load-bearing detail
people forget — they store the log, then can't trust its order.

```
  Q: why event timestamp for created_at?
  emit:   e₁ e₂ e₃ (in order)  →  flush: concurrent inserts (any order)
  now():  order corrupted by race   ✗
  event ts: order preserved          ✅  replay = emit order
```

**Q: There are two kinds of memory here. Why two storage shapes?**
Because they answer different recall questions. The trajectory (`messages`) is
recalled by *order* — read rows by `created_at` to replay what happened — so it's
ordered rows. Episodic memory (`chunks`, `meta.kind='memory'`) is recalled by
*relevance* — embed the new question, ANN-search for similar past exchanges — so
it rides the vector column and HNSW index. Same conversation, two access paths,
two tables. Forcing both into one shape would make one of the two recalls slow or
impossible.

**Q: Is the trajectory a transactional guarantee?**
No — it's best-effort. The user turn persists up front (`session.ts:61`), the
trajectory flushes after the run (`:63`), and memory-write is wrapped in a
swallow so a failure can't lose the answer (`:64-69`). A partial flush can leave
an incomplete trajectory. For a personal log that's the right tradeoff — the
answer still reached the user — but I'd name that the log is best-effort, not
atomic with the turn.

---

## See also

- `01-vector-column-and-ann-index.md` — the vector column episodic memory rides
- `02-deterministic-chunk-ids.md` — the `"memory:<conv>:<n>"` natural key
- `03-soft-link-no-fk.md` — why memory chunks (no document) need the dropped FK
- `audit.md` §1, §4 — model shape and the single real FK
- **study-debugging-observability** — the replay/observability view of this log

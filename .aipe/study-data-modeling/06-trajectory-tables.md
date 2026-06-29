# 06 · Trajectory tables

**Subtitle:** event-log capture of an agent run — `conversations` + `messages`
as a fully-populated, replayable trace — *Industry standard (agent observability)*.

---

## Zoom out, then zoom in

Every agent run leaves a complete record: the user's question, each assistant
step, every tool call with its arguments, every tool result with its duration and
errors, the model and token cost per inference, and any warnings. That record
lives in two tables — `conversations` (one row per session) and `messages` (one
row per event) — and it's the only place in the schema with a real foreign key.

```
  Zoom out — where the trajectory is written

  ┌─ Agent layer ───────────────────────────────────────────┐
  │  RagQueryAgent.answer() emits CapabilityEvents           │
  └───────────────────────────┬─────────────────────────────┘
                              │  6 event types → emit()
  ┌─ Trace layer ─────────────▼─────────────────────────────┐
  │  SupabaseTraceSink.emit → persistMessage(...)            │
  └───────────────────────────┬─────────────────────────────┘
                              │  insert per event
  ┌─ Storage: agents ─────────▼─────────────────────────────┐
  │  conversations  1 ──FK cascade──► N  messages  ★ here ★  │
  │  tool_calls/tool_results/model/tokens_used POPULATED      │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question is "can you reconstruct exactly what the agent did, in
order, after the fact?" The shape that answers yes is an append-only event log
with enough columns to replay the run — not just "user said X, agent said Y," but
the full causal chain including the tool args (the cause) and the durations and
token costs (the effect).

## The structure pass

One axis: **lifecycle** — when is each row written, and is it ever changed? Trace
it across the two tables.

```
  axis = "when is this row written, and does it mutate?"

  ┌─ conversations ────────────────┐  written once, at session start
  │  one row per createChatSession │  → never updated; the parent anchor
  └────────────────┬────────────────┘
                   │ seam: FK cascade — child lifecycle tied to parent
  ┌─ messages ─────▼────────────────┐  written per event, append-only
  │  one row per CapabilityEvent    │  → never updated; delete only via
  └─────────────────────────────────┘    parent cascade
```

The seam is the FK with `on delete cascade`. It's the one place in the schema
where a child's lifecycle is bound to a parent's: delete the conversation, the
messages go with it. Both tables are append-only — rows are inserted, never
updated — which is exactly the shape of an event log.

## How it works

### Move 1 — the mental model

The shape is an **append-only event log with a parent envelope** — the same
structure as a request log grouped by trace id, or git commits grouped by branch.
The conversation is the envelope; each message is one immutable event stamped with
when it happened. Replay = read the events in timestamp order.

```
  event log under one envelope (pattern)

  conversation (envelope)
  ├─ msg: user "what's X?"            t0
  ├─ msg: step  (assistant thinking)  t1
  ├─ msg: tool_call  search(args)     t2   ← the CAUSE (args captured)
  ├─ msg: tool       result+duration  t3   ← the EFFECT
  ├─ msg: model_usage  tokens         t4   ← the COST
  └─ msg: step  (final answer)        t5

  read in t-order → exact replay of the run
```

### Move 2 — the walkthrough

**The parent: one conversation per session.**

```
  File: sql/001_agents_schema.sql + src/supabase-trace-sink.ts
  Lines: 32-38 (schema) / 4-8 (startConversation)

    create table agents.conversations (
      id uuid primary key default gen_random_uuid(),    ← surrogate key
      app_id text not null default 'laptop',
      agent_name text not null default 'rag-query-agent',
      created_at timestamptz not null default now()
    );
    // startConversation: one insert, returns the id, held for the session
```

A conversation row is created once in `createChatSession` (`session.ts:55`) and
its id is held in-process across every turn. It's the trace id every message
hangs off.

**The child: one message per event, with the causal columns populated.**
The schema gives `messages` columns for the *full* signal — not just role and
content, but the tool payloads, the model, and the token count.

```
  File: sql/001_agents_schema.sql
  Lines: 40-50

    create table agents.messages (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid references agents.conversations(id)
        on delete cascade,                ← the one real FK + cascade
      role text not null,
      content text not null default '',
      tool_calls jsonb,        ← the tool name + ARGS (the cause)
      tool_results jsonb,      ← result + error + durationMs (the effect)
      model text,              ← which model produced the inference
      tokens_used int,         ← input+output tokens (the cost)
      created_at timestamptz not null default now()
    );
```

The comment-worthy part: `tool_calls`, `tool_results`, `model`, and `tokens_used`
are all **populated**, not left null. The trace sink fills each one from the
matching event type.

**The sink: every event variant maps to a row.**
`SupabaseTraceSink.emit` is a switch over all six `CapabilityEvent` types, each
writing the columns its event carries.

```
  File: src/supabase-trace-sink.ts
  Function: SupabaseTraceSink.emit
  Lines: 53-85

    case 'tool_call_start':                          ← the CAUSE
      persistMessage(..., 'tool_call', event.toolName, {
        toolCalls: { toolName, args: event.args },   ← args captured
        createdAt: at });
    case 'tool_call_end':                            ← the EFFECT
      persistMessage(..., 'tool', event.toolName, {
        toolResults: { result, error, durationMs },  ← outcome + timing
        createdAt: at });
    case 'model_usage':                              ← the COST
      persistMessage(..., 'model_usage', '', {
        model: `${event.provider}/${event.model}`,
        tokensUsed: (inputTokens ?? 0) + (outputTokens ?? 0),
        createdAt: at });
```

Each `case` populates exactly the columns that event knows about. `tool_call_start`
captures the args — the *cause* of a tool action, which the comment at
`supabase-trace-sink.ts:39-48` notes was "previously dropped on the floor."
`tool_call_end` captures the *effect* and timing. `model_usage` fills the
otherwise-orphaned `tokens_used` column.

**The replay-order discipline: `created_at` from the event, not the insert.**
This is the subtle, load-bearing part. The writes are queued and flushed
concurrently (`flush()` awaits a `Promise.all`), so insert order is a race. If
`created_at` defaulted to `now()` at insert time, the replay order would scramble.
Instead, the event's own timestamp is threaded through.

```
  File: src/supabase-trace-sink.ts + sql/001_agents_schema.sql
  Lines: persistMessage 26-36 / event timestamp at:55-56 / schema :49

    // persistMessage:
    const createdAt = extra?.createdAt?.length ? extra.createdAt : null;
    insert into agents.messages (..., created_at)
      values (..., coalesce($8::timestamptz, now()))  ← event time, else now()
    // emit: const at = event.timestamp;  ← the event's own clock
```

So replay order = `order by created_at`, which matches *emit* order, not the
concurrent-flush insert race. That's the difference between a log you can replay
and a log that's merely append-only.

```
  Layers-and-hops — sync emit, queued async write

  ┌─ agent ───────┐ emit(event)      ┌─ trace sink ─────────┐
  │ answer()      │ ───(sync)──────► │ push(persistMessage) │ queue
  └───────────────┘                  └──────────┬───────────┘
                                       hop: flush()│ Promise.all
                                                   ▼ (concurrent inserts)
                                       ┌─ messages ──────────┐
                                       │ created_at = event  │ ← order preserved
                                       │ time, NOT insert now│   despite the race
                                       └─────────────────────┘
```

**The boundary condition.** The append-only event-per-row shape means a single
agent turn produces *many* message rows (user + step + tool_call + tool + model +
step). Reconstructing "what was the assistant's final answer" means filtering by
role, not reading the last row. And — tying back to `audit.md` Lens 3 — there's
**no index on `conversation_id`**, so the `order by created_at where
conversation_id = ?` replay query that this shape is built for would seq-scan
until that index is added. The table is write-only today, so the gap is latent,
but it's pre-loaded into exactly the read this design exists to serve.

### Move 2 variant — the load-bearing skeleton

```
  the kernel of a replayable trajectory
    1. a parent envelope (conversation) with a stable id
    2. an append-only child row per event
    3. enough columns to reconstruct cause→effect→cost
    4. an ordering key that reflects EMIT time, not insert time
```

- Drop **(4)** (use insert-time `now()`) → concurrent flushes scramble order;
  the log is append-only but no longer *replayable*. This is the part people
  forget.
- Drop **(3)** (only role+content) → you see what was said, not why the agent
  did it or what it cost — the trace is a transcript, not a trajectory.
- Drop **(1)** the FK cascade → orphaned messages when a conversation is deleted.

### Move 3 — the principle

The difference between a transcript and a trajectory is causality. A transcript
says "user asked, agent answered." A trajectory captures the tool args (why the
agent did what it did), the durations and errors (what happened), and the token
counts (what it cost) — enough to *replay and debug* the run, not just read it.
The non-obvious requirement that makes it work is that the ordering key must come
from when the event *happened*, not when the row was *written*, because real
systems write concurrently. Get that wrong and you have all the data and none of
the order.

## Primary diagram

The full trajectory shape — envelope, events, columns, ordering.

```
  Trajectory tables — replayable agent trace

  ┌─ conversations (envelope, written once) ────────────────┐
  │  id uuid pk · app_id · agent_name · created_at           │
  └──────────────────────────┬───────────────────────────────┘
                  FK on delete cascade │ 1 → N
  ┌─ messages (append-only event log) ▼─────────────────────┐
  │  role  content  tool_calls  tool_results  model  tokens  │
  │  ─────────────  (args=CAUSE) (result+dur)  ───── (COST)   │
  │  created_at ← EVENT timestamp (coalesce $8, now())        │
  │                                                          │
  │  replay = SELECT * WHERE conversation_id=? ORDER BY      │
  │           created_at   ← needs an index (latent gap)     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

This is the agent-observability shape — the data side of what tracing systems
(OpenTelemetry spans, LLM trace tools) capture: a parent trace with timestamped,
typed events carrying enough structured payload to reconstruct the run. The
deliberate choice here is to land it in *relational* rows with `jsonb` for the
schemaless tool payloads, rather than a separate observability backend — which
keeps the trajectory queryable with plain SQL and colocated with the rest of the
agent's data. The honest gap is the missing `conversation_id` index: the schema
is built to be replayed but not yet indexed for replay, because no read consumes
it yet. The *debugging/observability* read of these same tables — what you'd
actually do with the trace — lives in `study-debugging-observability`.

## Interview defense

**Q: What makes your message log replayable rather than just append-only?**

The `created_at` column is set from the *event's* timestamp, not the insert time.
The trace sink queues writes and flushes them concurrently, so insert order is a
race — if `created_at` defaulted to `now()`, replay order would scramble. By
threading the event's own clock through `coalesce($8, now())`, `order by
created_at` reproduces emit order exactly.

```
  concurrent flush → insert order = race
  created_at = event.timestamp → order by created_at = TRUE emit order
```

Anchor: "append-only gives you the events; an emit-time ordering key gives you
the order — replay needs both."

**Q: Why capture `tool_calls` and `tool_results` separately instead of one row?**

Because they're cause and effect at different times. `tool_call_start` carries the
args — *why* the agent reached for the tool — and `tool_call_end` carries the
result, error, and duration — *what came back*. Splitting them into two
timestamped events preserves the causal sequence and the latency between
request and response, which is exactly what you need to debug a slow or failing
tool call.

```
  tool_call_start  args      t2   ← cause
  tool_call_end    result    t3   ← effect (+ durationMs = t3 - t2)
```

Anchor: "two events, not one row — the gap between them is the tool's latency."

## See also

- `05-app-id-tenant-column.md` — why `messages` reaches its tenant through the FK
  instead of carrying `app_id`.
- `03-soft-link-no-fk.md` — the contrast: this cluster *keeps* its FK with cascade.
- `audit.md` Lens 3 — the latent `conversation_id` index gap.
- `study-debugging-observability` — what you do with this trace once it's captured.

# Trajectory Tables (conversations / messages)

**Industry names:** event/turn log · append-only trajectory capture ·
parent-child with cascade. **Type:** Industry standard.

## Zoom out, then zoom in

Here's where the agent's run gets written down, and the one real foreign key
in the whole schema.

```
  Zoom out — where the trajectory tables live

  ┌─ CLI / agent layer ─────────────────────────────────┐
  │  RagQueryAgent.answer()  →  emits CapabilityEvents   │
  └───────────────────────────┬──────────────────────────┘
                              │  SupabaseTraceSink.emit()
  ┌─ Storage layer (Postgres) ▼──────────────────────────┐
  │  conversations  (one per chat session)               │
  │       │  conversation_id  FK ──► on delete cascade   │ ★ the ONE real FK
  │  messages       (one per event: every CapabilityEvent)│ ← we are here
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** A `conversations` row is created once per `npm run chat` session
(`src/session.ts:55`), not per question — every turn appends into that single
conversation. `messages` rows append per *event*: the user question, each
assistant step, tool-call args, tool results, model/token usage, and
warning/error events. Every column on the row is now written (`tool_calls`,
`tool_results`, `model`, `tokens_used`, `created_at`), so the table is a
complete replayable trajectory rather than a half-filled log. Unlike the
corpus side, this pair *keeps* its foreign key, with `on delete cascade`. The
question: *why does the schema enforce integrity here but not on chunks?*

## The structure pass

**Layers:** (1) `conversations` — the parent, one per run, uuid PK. (2)
`messages` — children, append-only, FK to the parent. (3) the cascade — the
parent's delete reaches the children.

**Axis — who guarantees the parent exists:** trace the same axis you traced
on chunks (`04`), and watch it answer *differently*. Here the **database**
guarantees it: `messages.conversation_id references conversations(id)`. Insert
a message for a non-existent conversation and the DB rejects it. Delete a
conversation and its messages cascade. This is the opposite answer from
`chunks → documents`, and the contrast is the whole point.

**Seam:** the load-bearing boundary is **why the FK survives here**. The
trace sink writes messages through *buffr's own code*
(`src/supabase-trace-sink.ts`), not through an external `VectorStore`
contract. Nothing forbids the FK, so the schema keeps it. The seam between
`04` (FK dropped) and this file (FK kept) is "is there an external contract
that forbids referential integrity?" — chunks: yes; messages: no.

## How it works

### Move 1 — the mental model

You know how a todo app models "a list has many items," and deleting the list
should delete its items? `conversations → messages` is exactly that
parent-child with `on delete cascade`. The agent run is the list; each turn is
an item; drop the run and the turns go with it.

```
  parent-child with cascade — one conversation, many events

  conversations  ●  id = c1
                 │  on delete cascade
       ┌─────┬─────┼─────┬──────────┬────────────┐
       ▼     ▼     ▼     ▼          ▼            ▼
  messages user  step tool_call  tool       model_usage  (append-only)
            "q"  text  +args     +result     model+tokens
       └─────────────── delete c1 ───────────────┘
            every message cascade-deleted by the DB
```

### Move 2 — the step-by-step walkthrough

**Conversation is created once per session, returns its id.**
`startConversation` inserts a `conversations` row and `returning id` hands
back the uuid (`src/supabase-trace-sink.ts:4-8`), called from
`createChatSession` (`src/session.ts:55`) — once, then held for every turn.
The DB generates the uuid (`gen_random_uuid()`, `sql/001_agents_schema.sql:33`)
— surrogate key, because a conversation has no natural identity (contrast the
corpus side's deterministic ids, `03`).

**Messages append against that id.** The user question goes in first
(`src/session.ts:61`, `persistMessage(... 'user', question)`), then the sink
emits assistant/tool/usage events as the agent runs
(`src/supabase-trace-sink.ts:53-84`). Each insert carries `conversation_id` —
and the FK *checks it exists*. You cannot append a message to a conversation
that isn't there; the DB rejects it. This is the integrity that `chunks` gave
up.

**Every column is written now — not just role + content.** `persistMessage`
inserts all eight columns (`src/supabase-trace-sink.ts:27-37`), and the sink
fills them per event type (`:56-84`): `tool_call_start` writes the call args
into `tool_calls`; `tool_call_end` writes result + error + durationMs into
`tool_results`; `model_usage` writes `model` (`provider/model`) and
`tokens_used` (`inputTokens + outputTokens`). Earlier these columns existed in
the DDL but nothing wrote them — they were orphaned/null. They're now
populated, so the row carries the *cause* (tool args, token cost), not just
the effect.

**`created_at` is client-supplied, not server `now()`.** Each event carries a
`timestamp`, and the insert binds it as `coalesce($8::timestamptz, now())`
(`src/supabase-trace-sink.ts:30`) — so the row's `created_at` is the moment
the event *emitted*, falling back to server `now()` only when absent. This
matters for ordering (next paragraph).

**The sink batches, then flushes.** aptkit's `emit` is synchronous (the
contract), so the sink pushes each write's promise into a `pending` array and
`flush()` awaits them all after the run (`:50,87-93`). The inserts race, so
*insert* order within a run isn't strictly guaranteed — but because
`created_at` is now the event timestamp (not the random insert moment), an
`order by created_at` replays events in true emit order rather than the
flush race order.

**Cascade on delete.** Drop a `conversations` row and every `messages` row
with that `conversation_id` is deleted by the DB, atomically, no app code
involved (`sql/001_agents_schema.sql:42`, `on delete cascade`). This is the
one place the schema enforces a multi-row invariant for you.

### Move 2 variant — the load-bearing skeleton

The kernel of trajectory capture, named by what breaks:

- **the FK `conversation_id → conversations(id)`.** Drop it and a message can
  reference a dead conversation — orphan turns with no run, exactly the
  `chunks` problem. Keep it: every message provably belongs to a real run.
- **`on delete cascade`.** Drop it (plain FK) and deleting a conversation
  *fails* while messages reference it, or leaves orphans if you force it.
  Cascade is what makes "delete a run" a single safe operation.
- **append-only + client-supplied `created_at`.** No updates, no deletes of
  individual turns — the trajectory is an immutable log. `created_at` is now
  the event's emit timestamp (`:30`), so replay order is faithful even though
  inserts race. Remove the append-only discipline and you lose the ability to
  replay/audit a run faithfully.

**Skeleton vs hardening.** Kernel: parent + FK + cascade + append-only.
Hardening *now present*: the `tool_calls` / `tool_results` / `model` /
`tokens_used` columns are filled per event (`:56-84`), and `created_at` carries
the event timestamp for ordering — none of which existed as live data before.
Hardening still not present: a strict integer turn-sequence column (ordering
leans on `created_at`, which is fine until two events share a millisecond),
partitioning by time for retention, or `app_id`-scoped RLS (the column's
there, `:34`, but unenforced — see `05`).

### Move 3 — the principle

When *you* own both sides of a relationship, enforce it in the database — a FK
with cascade is free correctness you'd otherwise hand-roll in app code and get
wrong. The reason `chunks` couldn't have this (`04`) is an external contract;
the reason `messages` *does* is that nothing forbade it. Same schema, and the
presence-or-absence of the FK tells you exactly where an external contract
crosses the boundary.

## Primary diagram

```
  the run, captured — one frame

  ┌─ session.ts ─────────────────────────────────────────┐
  │  startConversation() → conversations row (uuid)  (1x) │
  │  persistMessage('user', question)        (per turn)   │
  └───────────────────────┬───────────────────────────────┘
                          │  agent runs, sink emits per event
  ┌─ SupabaseTraceSink ───▼───────────────────────────────┐
  │  emit(step)           → push insert (content)          │
  │  emit(tool_call_start)→ push insert (tool_calls=args)  │
  │  emit(tool_call_end)  → push insert (tool_results)     │
  │  emit(model_usage)    → push insert (model,tokens_used)│
  │  emit(warning|error)  → push insert (message)          │
  │  flush() → await all                                   │
  └───────────────────────┬───────────────────────────────┘
                          │  every insert carries conversation_id
                          │  + created_at = event.timestamp
  ┌─ Postgres ────────────▼───────────────────────────────┐
  │  messages.conversation_id  FK ──► conversations.id     │
  │                            on delete cascade           │
  │  all cols filled: tool_calls/tool_results/model/tokens │
  │  → orphans impossible; delete a run, events cascade    │
  └─────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Every `npm run chat` session writes one conversation and, across
its turns, N messages — the user turn, each assistant step, tool-call args,
each tool result, and model/token usage. This is the agent's audit trail: what
was asked, what the model said, what tools ran with what arguments, and what
each turn cost in tokens — all replayable in emit order via `created_at`.

**The FK + cascade — `sql/001_agents_schema.sql:40-50`:**

```
  create table agents.messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid references agents.conversations(id)
                         on delete cascade,        ← the ONE real FK + cascade
    role text not null,                            ← user | assistant | tool
    content text not null default '',
    tool_calls jsonb,                              ← schemaless turn payloads
    tool_results jsonb,
    ...
  );
       │
       └─ unlike chunks (FK dropped, 04), nothing forbids this FK here, so
          the schema keeps it. Delete a conversation → messages cascade.
```

**The writes — `src/supabase-trace-sink.ts:4-8,27-37,53-84`:**

```
  insert into agents.conversations (app_id, agent_name)
    values ($1, $2) returning id    ← surrogate uuid handed back (1x/session)

  insert into agents.messages
    (conversation_id, role, content, tool_calls, tool_results,
     model, tokens_used, created_at)
    values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
         │                                       │
         │  FK checks $1 exists; reject if not   └─ $8 = event.timestamp:
         │                                          replay = emit order,
         └─ ALL eight cols bound — previously                NOT server now()
            tool_calls/tool_results/model/tokens were null

  switch (event.type) {                          ← every variant persisted
    case 'tool_call_start': … tool_calls = {toolName, args}
    case 'tool_call_end':   … tool_results = {result, error, durationMs}
    case 'model_usage':     … model = `${provider}/${model}`,
                              tokens_used = inputTokens + outputTokens
    case 'warning'|'error': … role = type, content = message
  }
  async flush() { await Promise.all(this.pending); }  ← sync emit, deferred await
```

## Elaborate

This is the standard agent-trajectory / event-log shape: an immutable,
append-only child table under a per-session parent, with cascade so a run is
one deletable unit. The `tool_calls` / `tool_results` jsonb columns absorb
provider-specific event payloads without a column per field — the same
jsonb-sidecar reasoning as the corpus `meta`, but here it's the *right* call
(event shapes genuinely vary, and nothing duplicates them into columns, so no
`02`-style redundancy). Note these columns are no longer aspirational: the
trace sink fills them on every run (`:56-84`), turning what was a half-written
log into a complete trajectory. The thing to carry away: this table is the
counter-example that proves the `chunks` FK drop (`04`) was a *contract*
decision, not a house style — when buffr owns both sides, it reaches for the
FK every time.

## Interview defense

**Q: Your schema dropped the FK on `chunks` but kept it on `messages`. Isn't
that inconsistent?**

```
  chunks → documents :  FK DROPPED  (external VectorStore contract forbids it)
  messages → convos  :  FK KEPT     (buffr owns both sides, nothing forbids)
```
Answer: it's consistent on the *rule* — enforce integrity in the DB unless an
external contract forbids it. Chunks implement aptkit's `VectorStore`, which
knows nothing about parents, so a FK breaks parity (`04`). Messages are
written by my own trace sink with no such contract, so the FK + cascade stay.
The presence of the FK is a marker of where an external contract crosses the
boundary. **Anchor:** `:42` (kept) vs `:27` (dropped).

**Q: How are turns ordered for replay?**

By `created_at`, but it's the *event's emit timestamp* now, not server
`now()` — the sink binds `coalesce($8::timestamptz, now())` with `$8 =
event.timestamp` (`supabase-trace-sink.ts:30,55`). The sink's `emit` is sync
and writes are fire-and-collect via `flush()`, so the *inserts* race and their
DB-assigned order isn't meaningful — but `order by created_at` recovers true
emit order regardless. The remaining gap: two events in the same millisecond
tie; a strict integer `turn_index` would break the tie. **Anchor:**
`supabase-trace-sink.ts:30,55,87-93`.

## Validate

1. **Reconstruct:** draw the parent-child cascade and say what a manual
   `delete from conversations` does to messages.
2. **Explain:** why does `messages` keep its FK when `chunks` dropped one?
   (`sql/001_agents_schema.sql:42` vs `:27`)
3. **Apply:** two events emitted in the same millisecond can tie on replay
   order. Why does `created_at` (event timestamp, `supabase-trace-sink.ts:30`)
   fix the flush-race but not the same-ms tie, and what column would?
4. **Defend:** justify surrogate uuid keys here vs the deterministic ids on
   the corpus side (`03`).

## See also

- `04-soft-link-no-fk.md` — the FK that was dropped (the contrast).
- `03-deterministic-chunk-ids.md` — surrogate vs natural key, the other side.
- `05-app-id-tenant-column.md` — these tables carry `app_id` too, unenforced.
- `audit.md` §4 — the one real FK, integrity enforced here.

---
Updated: 2026-06-24 — trace sink now writes all 6 CapabilityEvent types, so
`tool_calls`/`tool_results`/`model`/`tokens_used` columns are populated (were
orphaned/null) and `created_at` is the client-supplied event timestamp (was
server `now()`); conversation is per `npm run chat` session not per ask;
purged `ask`/`ask-cmd.ts` refs → `session.ts`/`chat`.

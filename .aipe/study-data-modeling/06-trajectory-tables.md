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
  │  conversations  (one per ask run)                    │
  │       │  conversation_id  FK ──► on delete cascade   │ ★ the ONE real FK
  │  messages       (one per turn: user/assistant/tool)  │ ← we are here
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** A `conversations` row is created per `npm run ask`; `messages`
rows append per turn — user question, assistant steps, tool calls. Unlike the
corpus side, this pair *keeps* its foreign key, with `on delete cascade`.
The question: *why does the schema enforce integrity here but not on chunks?*

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
  parent-child with cascade — one conversation, many turns

  conversations  ●  id = c1
                 │  on delete cascade
       ┌─────────┼─────────┬─────────────┐
       ▼         ▼         ▼             ▼
  messages   user     assistant      tool       (append-only)
             "ask"    "step text"    "result"
       └──────────── delete c1 ───────────┘
                 all four messages cascade-deleted by the DB
```

### Move 2 — the step-by-step walkthrough

**Conversation is created first, returns its id.** `startConversation`
inserts a `conversations` row and `returning id` hands back the uuid
(`src/supabase-trace-sink.ts:4-8`). The DB generates the uuid
(`gen_random_uuid()`, `sql/001_agents_schema.sql:33`) — surrogate key,
because a conversation has no natural identity (contrast the corpus side's
deterministic ids, `03`).

**Messages append against that id.** The user question goes in first
(`src/cli/ask-cmd.ts:30`), then the sink emits assistant/tool turns as the
agent runs (`src/supabase-trace-sink.ts:27-35`). Each insert carries
`conversation_id` — and the FK *checks it exists*. You cannot append a
message to a conversation that isn't there; the DB rejects it. This is the
integrity that `chunks` gave up.

**The sink batches, then flushes.** aptkit's `emit` is synchronous (the
contract), so the sink pushes each write's promise into a `pending` array and
`flush()` awaits them all after the run (`:27-39`). The ordering note: these
are fire-and-collect, so message insert order within a run isn't strictly
guaranteed — `created_at` defaults order them for reads, not insert sequence.

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
- **append-only + `created_at` default.** No updates, no deletes of
  individual turns — the trajectory is an immutable log. Remove the
  append-only discipline and you lose the ability to replay/audit a run
  faithfully.

**Skeleton vs hardening.** Kernel: parent + FK + cascade + append-only.
Hardening not present: a turn-sequence column for strict ordering (relies on
`created_at` instead), partitioning by time for retention, or `app_id`-scoped
RLS (the column's there, `:34`, but unenforced — see `05`).

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

  ┌─ ask-cmd.ts ─────────────────────────────────────────┐
  │  startConversation() → conversations row (uuid)       │
  │  persistMessage(user, question)                       │
  └───────────────────────┬───────────────────────────────┘
                          │  agent runs, sink emits
  ┌─ SupabaseTraceSink ───▼───────────────────────────────┐
  │  emit(step/assistant)  → pending.push(insert message)  │
  │  emit(tool_call_end)   → pending.push(insert message)  │
  │  flush() → await all                                   │
  └───────────────────────┬───────────────────────────────┘
                          │  every insert carries conversation_id
  ┌─ Postgres ────────────▼───────────────────────────────┐
  │  messages.conversation_id  FK ──► conversations.id     │
  │                            on delete cascade           │
  │  → orphans impossible; delete a run, turns cascade     │
  └─────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Every `npm run ask` writes one conversation and N messages —
the user turn, each assistant step, each tool result. This is the agent's
audit trail: what was asked, what the model said, what tools ran.

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

**The writes — `src/supabase-trace-sink.ts:4-8,14-19,27-35`:**

```
  insert into agents.conversations (app_id, agent_name)
    values ($1, $2) returning id    ← surrogate uuid handed back

  insert into agents.messages (conversation_id, role, content, ...)
    values ($1, $2, $3, ...)        ← FK checks $1 exists; reject if not

  emit(event) { this.pending.push(persistMessage(...)); }  ← sync emit,
  async flush() { await Promise.all(this.pending); }          deferred await
```

## Elaborate

This is the standard agent-trajectory / event-log shape: an immutable,
append-only child table under a per-run parent, with cascade so a run is one
deletable unit. The `tool_calls` / `tool_results` jsonb columns absorb
provider-specific turn payloads without a column per field — the same
jsonb-sidecar reasoning as the corpus `meta`, but here it's the *right* call
(turn shapes genuinely vary, and nothing duplicates them into columns, so no
`02`-style redundancy). The thing to carry away: this table is the
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

By `created_at` default, not a sequence column — the sink's `emit` is sync and
writes are fire-and-collect via `flush()`, so insert order isn't strictly
guaranteed; read order leans on the timestamp. A strict `turn_index` would
harden it. **Anchor:** `supabase-trace-sink.ts:27-39`.

## Validate

1. **Reconstruct:** draw the parent-child cascade and say what a manual
   `delete from conversations` does to messages.
2. **Explain:** why does `messages` keep its FK when `chunks` dropped one?
   (`sql/001_agents_schema.sql:42` vs `:27`)
3. **Apply:** turns sometimes appear slightly out of order on replay. Where's
   that coming from, and what column would fix it? (`supabase-trace-sink.ts`)
4. **Defend:** justify surrogate uuid keys here vs the deterministic ids on
   the corpus side (`03`).

## See also

- `04-soft-link-no-fk.md` — the FK that was dropped (the contrast).
- `03-deterministic-chunk-ids.md` — surrogate vs natural key, the other side.
- `05-app-id-tenant-column.md` — these tables carry `app_id` too, unenforced.
- `audit.md` §4 — the one real FK, integrity enforced here.

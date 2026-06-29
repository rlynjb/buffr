# 04 — Long-Lived Chat Session

**Industry name(s):** Long-lived session / stateful connection-per-session / warm-pool
orchestrator. The "build-once, serve-many-turns" lifecycle.
**Type:** Industry standard (session lifecycle), project-specific wiring.

## Zoom out, then zoom in

Here's the whole system, with the orchestrator lit. `npm run chat` opens an Ink terminal
UI that holds **one conversation in one process across every turn**. Behind it,
`createChatSession` builds the agent, the pool, and the conversation *once* at startup;
each turn just calls `ask()`. This replaced the old one-shot `npm run ask`, which opened
and closed everything per call (`.aipe/project/context.md:12`).

```
  Zoom out — where the session orchestrator sits

  ┌─ Interface layer ───────────────────────────────────────────────────┐
  │  Ink TUI (src/cli/chat.tsx) — input box · turn list · spinner         │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ session.ask(q) / session.close()
  ┌─ Session layer ───────────────▼──────────────────────────────────────┐
  │  ★ createChatSession (src/session.ts) ★                               │ ← we are here
  │    built ONCE: warm pool · agent · conversationId · memory engine     │
  │    per turn: persist → answer → flush → remember                      │
  └──────┬──────────────┬───────────────┬───────────────┬────────────────┘
         ▼              ▼               ▼               ▼
     aptkit agent   retrieval      trace sink       memory engine
                    pipeline
  ┌─ Storage layer ──────────────────────────────────────────────────────┐
  │  one Postgres connection pool · one conversation row                  │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is a **long-lived stateful session**: expensive setup happens once,
state (the conversation, the warm pool) is held in a closure, and many cheap operations
run against it. The question it answers: *how do you keep one conversation coherent and
fast across an interactive session, instead of paying full setup cost and losing context
on every turn?*

## Structure pass

**Layers:** UI (Ink component) → orchestrator (`createChatSession`) → wired services
(agent / pipeline / sink / memory) → storage (one pool, one conversation).

**Axis — lifecycle: when does each thing get created?** Trace it. The pool, the embedder,
the store, the pipeline, the agent, the profile load, the memory engine, the
conversation row — **all created once, at session construction** (`src/session.ts:39-57`).
Only three things run *per turn*: persist the user message, `agent.answer()`, and the
flush+remember tail (`src/session.ts:60-71`). The build/serve boundary is sharp — that's
the lifecycle flip, and it's the entire performance argument for this design.

**Seam:** the `ChatSession` type (`src/session.ts:29-32`) — `{ ask, close }`. A horizontal
seam between the UI and everything below it. The UI promises to call `ask` per submit and
`close` on exit; the session promises to keep one coherent conversation behind those two
methods. The UI never sees a pool, an agent, or Postgres.

## How it works

### Move 1 — the mental model

You know how a React custom hook does its expensive setup once (a `useRef` holding a
client, a `useMemo` building a config) and then exposes a cheap callback you call on
every event? `createChatSession` is that, for a terminal process: the closure *is* the
ref, the returned `ask` *is* the callback. The strategy: **construct the world once, hold
it in a closure, expose a narrow per-turn method.**

```
  the session lifecycle — build once, serve N turns

   startup ──► build: pool · agent · conversationId · memory   (once)
      │
      ▼
   turn 1 ──► ask(q1) ─► persist → answer → flush → remember
   turn 2 ──► ask(q2) ─► persist → answer → flush → remember     (same world)
   turn N ──► ask(qN) ─► ...
      │
      ▼
   /exit  ──► close() ─► pool.end()                              (once)
```

### Move 2 — the walkthrough

**Build once — the warm world.** `createChatSession` does all the expensive wiring
before returning (`src/session.ts:34-57`): one `pg.Pool` (the warm connection cache), the
embedder, the `PgVectorStore`, the pipeline, the search tool with a `minTopK: 4` floor,
the guarded Gemma provider, the profile loaded from Postgres, the memory engine, and one
`conversationId` from `startConversation`. The agent is constructed *once* with all of
this (`src/session.ts:57`).

```ts
// src/session.ts:55-57 — one conversation, one agent, built before any turn
const conversationId = await startConversation(pool, cfg.appId);
const trace = new SupabaseTraceSink({ pool, conversationId });
const agent = new RagQueryAgent({ model, tools, profile, trace });
```

What breaks if you build per turn instead: every question reloads the profile, reopens a
connection, and starts a *new* conversation row — so the trajectory fragments across
conversations and warm-pool latency vanishes. The old `npm run ask` did exactly this; the
session exists to stop it.

**Serve a turn — the fixed four-step tail.** Every `ask` runs the same ordered sequence
(`src/session.ts:60-71`):

```ts
// src/session.ts:60-71 — the per-turn contract
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);   // 1. record the cause
  const answer = await agent.answer(question);                    // 2. run the agent (emits traces)
  await trace.flush();                                            // 3. drain the trajectory
  try {
    await memory.remember({ conversationId, question, answer });  // 4. best-effort recall seed
  } catch { /* swallow: memory is best-effort, the turn already succeeded */ }
  return answer;
}
```

Walk it one step at a time:

1. **Persist the user turn first.** The user's question lands in `messages` before the
   agent runs, so even a mid-run crash leaves the cause on record.
2. **`agent.answer()`.** aptkit's loop runs — Gemma may call `search_knowledge_base`,
   then synthesizes. Traces emit into the sink during this step (file 03).
3. **`flush()`.** Drain the queued trajectory writes *after* the answer is in hand — flush
   after answer, not during (file 03).
4. **`remember()`, wrapped in try/catch.** This is the load-bearing reliability decision:
   a memory-write failure is *swallowed* so the answer the user already has is never lost
   (`src/session.ts:65-69`). The answer is the product; memory is a bonus.

```
  Layers-and-hops — one turn through the session

  ┌─ Ink TUI ─┐ hop 1: ask(q)        ┌─ session ─┐
  │ onSubmit  │ ────────────────────► │ persist   │ hop 2: INSERT user ──► messages
  └─────┬─────┘                       │ answer ───┼ hop 3: loop+emit ────► (agent/Ollama)
        │                             │ flush ────┼ hop 4: INSERT ×N  ──► messages
        │                             │ remember ─┼ hop 5: upsert     ──► chunks(memory)
        │ hop 6: answer ◄─────────────┤           │
  ┌─────▼─────┐                       └───────────┘
  │ setTurns  │
  └───────────┘
```

**The UI is dumb on purpose.** `src/cli/chat.tsx` holds only render state — `turns`,
`input`, `busy` (`src/cli/chat.tsx:11-13`). On submit it guards against re-entry while
busy (`src/cli/chat.tsx:17`), calls `session.ask`, and pushes the answer into `turns`;
on error it renders an error turn instead of crashing (`src/cli/chat.tsx:30-32`). On
`/exit` it calls `session.close()` then `exit()` (`src/cli/chat.tsx:18-22`). All the
state that *matters* lives in the session and in Postgres; the UI just paints it.

**One known limit, named.** The conversation is coherent via *retrieval*, not via an
in-prompt turn history — `RagQueryAgent.answer()` treats each question independently
(`src/session.ts:25-27`). Sequential turn history is an aptkit-side change; today,
relevance-based recall (file 06) gives memory without it. This is an honest gap, not a
bug.

### Move 3 — the principle

Pay expensive setup once and hold the result; expose a narrow method for the repeated
work. The discipline that makes a session *correct* (not just fast) is ordering the
per-turn steps so the durable record survives partial failure — persist the cause first,
flush the trajectory after the answer, and make the bonus (memory) unable to sink the
product (the answer). Fast comes from the warm pool; correct comes from the order.

## Primary diagram

The full session, build-once vs serve-many, the four-step turn, every layer.

```
  createChatSession — build once, serve many

  ┌─ Ink TUI (render state only: turns · input · busy) ─────────────────┐
  └───────────────────────────────┬──────────────────────────────────────┘
                ask(q)             │             close()
  ┌─ ChatSession closure ─────────▼──────────────────────────────────────┐
  │  built ONCE:  pool · embedder · store · pipeline · tool(minTopK 4) ·  │
  │               guarded Gemma · profile · memory · conversationId · agent│
  │                                                                        │
  │  per ask():   1 persist user → 2 agent.answer (emits) →                │
  │               3 trace.flush → 4 memory.remember (best-effort)          │
  │  per close(): pool.end()                                               │
  └──────┬───────────────┬────────────────┬───────────────┬───────────────┘
         ▼               ▼                ▼               ▼
   agents.messages  (Ollama loop)   agents.messages   agents.chunks(memory)
   (user turn)      via agent        (trajectory)      (recall seed)
```

## Elaborate

This is the classic interactive-session lifecycle — a REPL, a database client session, a
websocket connection handler — where setup is amortized over many operations. The repo's
specific stake: a single device has exactly one client, so a stateful in-process session
is the *right* shape, not a scaling compromise (`...graduation-design.md:27`). At scale
this is the first thing that changes — a stateful process doesn't sit behind a load
balancer (audit lens 7). The build-once/serve-many split is the same instinct as a warm
Lambda container or a connection pool: the cost you refuse to pay twice. Execution-model
details (how the single Node process schedules the async tail, event-loop behavior)
belong to `study-runtime-systems`.

What to read next: `03-trajectory-capture.md` (step 3 of the turn),
`06-retrieval-as-memory.md` (step 4 of the turn), `01-vector-store-adapter.md` (the store
built once at startup).

## Interview defense

**Q: Why a long-lived session instead of one-shot per question?**
Coherence and speed. One-shot reopens the pool, reloads the profile, and starts a *new*
conversation per question — fragmenting the trajectory and paying full setup latency
every turn. The session builds the pool, agent, and conversation once and holds them, so
every turn shares one warm world and one conversation row.

```
  one-shot:  per turn → connect · load profile · NEW conversation  (fragmented)
  session:   startup  → connect · load profile · ONE conversation  (coherent)
```
Anchor: build-once at `src/session.ts:39-57`; the replaced one-shot at
`.aipe/project/context.md:12`.

**Q: What's the load-bearing ordering decision in the per-turn path?**
Persist the user turn *first*, flush the trajectory *after* the answer, and wrap
`remember` in try/catch so a memory failure can't lose the answer. The answer is the
product; memory is best-effort.
Anchor: the four steps at `src/session.ts:60-71`; the swallow at `:65-69`.

**Q: How is the conversation coherent if the agent treats each question
independently?**
Through retrieval, not in-prompt history. Each turn's exchange is remembered as a vector;
future turns surface relevant past exchanges via `search_knowledge_base`. Sequential
in-prompt history is an aptkit-side change, not yet done — named honestly.
Anchor: the limit at `src/session.ts:25-27`; recall mechanism in `06-retrieval-as-memory.md`.

## See also

- `03-trajectory-capture.md` — what `trace.flush()` (step 3) drains
- `06-retrieval-as-memory.md` — what `memory.remember()` (step 4) seeds
- `01-vector-store-adapter.md` — the store wired in at build time
- `study-runtime-systems` — the single-process event loop the session runs on

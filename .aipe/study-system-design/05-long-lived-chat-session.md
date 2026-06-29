# 05 — Long-Lived Chat Session

**Industry name(s):** the session object / connection-pooled long-lived session · build-once, run-per-turn · the warm-pool pattern. **Type:** Industry standard.

## Zoom out — where this concept lives

The whole interface is one long-lived process holding **one conversation**. `npm run chat`
opens a session, and that session keeps a warm pg pool, builds the agent exactly once, and runs
every turn against the same in-memory wiring. This replaced the old one-shot `npm run ask`, which
opened and closed everything per call. The session is the layer between the UI and aptkit.

```
  Zoom out — the session in the system

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  src/cli/chat.tsx — Ink TUI, calls session.ask(q) per submit   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  in-process call (no HTTP)
  ┌─ Session layer (buffr owns) ──▼──────────────────────────────┐
  │  ★ createChatSession() ★   src/session.ts                     │
  │   built ONCE at startup: pool · agent · memory · conversation │
  │   reused per turn: ask() → persist → answer → flush → remember│
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ aptkit + Storage ────────────▼──────────────────────────────┐
  │  RagQueryAgent · pg.Pool → agents.* tables                    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **build-once, run-per-turn session**. The question it answers: *what's
expensive to build, and how do you pay for it once instead of every turn?* Answer — build the pool,
the agent, the memory engine, and the conversation row at session start; hold them in a closure;
every `ask()` reuses them.

## Structure pass — layers, axis, seam

**Layers:** process lifetime → session lifetime → turn lifetime.

**Axis — trace *lifecycle: when does this happen* across the three nested lifetimes:**

```
  axis = "when does this happen — once, per session, or per turn?"

  process start ──► createChatSession()   ── ONCE: pool, agent, memory, conversationId
       │
       └─ each submit ──► ask(q)          ── PER TURN: persist → answer → flush → remember
                              │
                              └─ inside ──► agent loop, tool calls  ── PER STEP

  three nested clocks. the expensive setup ticks once; the cheap turn work ticks per ask.
```

**The seam:** the closure returned by `createChatSession()` (`session.ts:59-76`). Everything built
above the `return` is session-scoped and built once; everything inside `ask()` runs per turn. That
boundary — between "set up once" and "do per turn" — is the seam. Cross it and the lifecycle axis
flips from once-per-session to once-per-turn. Putting the wrong thing on the wrong side is the bug
this pattern prevents (rebuild the agent every turn → slow; share the conversation id → continuity).

## How it works

### Move 1 — the mental model

You know the difference between creating a `fetch` client inside a render (rebuilt every render,
wasteful) versus once in a module scope (built once, reused). The session is that, for a whole agent:
the pool, the model provider, the tool registry, and the agent object are all built once at the top
of `createChatSession` and *closed over*, so each `ask()` is just the per-turn work.

```
  Build-once, run-per-turn — the session shape

  createChatSession()                    ← runs ONCE
  ┌──────────────────────────────────┐
  │ pool   = createPool(...)          │   warm connections, reused
  │ agent  = new RagQueryAgent(...)   │   built once
  │ memory = createConversationMemory │   engine, once
  │ conversationId = startConversation│   ONE conversation row
  └───────────────┬──────────────────┘
                  │ returns a closure { ask, close }
                  ▼
  ask(q) ──┐  ask(q) ──┐  ask(q) ──┐     ← runs PER TURN, reusing the above
           │           │           │
        persist     persist     persist
        answer      answer      answer    same agent, same pool, same conversation
        flush       flush       flush
        remember    remember    remember
```

### Move 2 — the walkthrough

**Build once — the setup above the return.** Everything from the pool to the agent is constructed
a single time when the session opens (`session.ts:39-57`):

```ts
// src/session.ts:39
const pool = createPool(cfg.databaseUrl);                          // warm pool, held for the session
const embedder = new OllamaEmbeddingProvider({ ... });
const store = new PgVectorStore({ pool, appId, dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([...], {...});
const model = new ContextWindowGuardedProvider(new GemmaModelProvider({...}), { maxTokens: 8192 });
const profile = await loadProfile(pool, cfg.appId);               // read once
const memory = createConversationMemory({ embedder, store });
const conversationId = await startConversation(pool, cfg.appId);  // ONE conversation row
const trace = new SupabaseTraceSink({ pool, conversationId });
const agent = new RagQueryAgent({ model, tools, profile, trace });  // built once
```

Three things are load-bearing here. The `pool` is warm — node-postgres keeps connections open and
hands them out per query, so no per-turn connect/disconnect (contrast the old one-shot `ask`, which
"opens and closes per call", `session.ts:14-16`). The `profile` is read once (`loadProfile`,
`profile.ts:4-8`) — it doesn't change mid-session. The `conversationId` is created once, so every
turn's trajectory lands under the *same* conversation row — that's what makes it "one conversation
across turns" rather than a new conversation per question.

**Run per turn — the ordered `ask`.** The turn body is four steps in a deliberate order
(`session.ts:60-71`):

```ts
// src/session.ts:60
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // 1. user turn durable FIRST
  const answer = await agent.answer(question);                   // 2. run the (reused) agent
  await trace.flush();                                           // 3. drain the trajectory (03)
  try {
    await memory.remember({ conversationId, question, answer }); // 4. best-effort memory (04)
  } catch { /* swallow: memory is best-effort, the turn already succeeded */ }
  return answer;
}
```

The order *is* the reliability design (audit lens 6). Persist the user turn **before** answering, so
a crash mid-generation still leaves the question as a row. Flush the trajectory **before** the
best-effort memory write, so the durable trajectory is safe before the optional step runs. Memory
last and swallowed, so its failure can't lose the answer. Each step depends on the same session-scoped
objects built above — `agent`, `trace`, `memory`, `conversationId` — none rebuilt.

**The UI just drives it.** `chat.tsx` holds no agent, no pool — only screen state. It calls
`session.ask` and renders the result, catching errors into a turn instead of crashing
(`chat.tsx:27-34`):

```tsx
// src/cli/chat.tsx:27
try {
  const answer = await session.ask(q);                  // all the work is behind the session
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);
} catch (err) {
  setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
} finally { setBusy(false); }
```

And `/exit` calls `session.close()` (`chat.tsx:18-22` → `session.ts:72-74`), which ends the pool —
the one teardown step, matching the one setup.

**The honest gap — no in-prompt turn history.** `session.ts:25-28` names it: `RagQueryAgent.answer()`
treats each question independently; there's no growing message array in the prompt. Continuity comes
from retrieval-based memory (`04`), not from the prompt window. So "one conversation" means *one
trajectory and one memory stream*, not *one prompt context that grows*. That's a deliberate scoping
call — sequential in-prompt history is "an aptkit-side change" (`session.ts:27`), deferred.

### Move 2 variant — the load-bearing skeleton

```
  Long-lived session kernel:
    1. build expensive things once    — pool, agent, memory, conversationId
    2. hold them in a closure         — ask()/close() capture them
    3. ONE conversationId per session — every turn's trajectory under one row
    4. ordered per-turn body          — persist → answer → flush → remember
    5. warm pool, closed once         — connections reused, ended at /exit
```

- Drop **#1** (rebuild the agent each turn) → you've rebuilt the one-shot `ask`; every turn re-pays
  setup.
- Drop **#3** (new conversation per turn) → the trajectory fragments; "one conversation" is a lie.
- Drop **#4's ordering** → a crash loses the user turn, or memory failure loses the answer.

Optional hardening *not* here: reconnect-on-pool-error, a turn timeout, a max-history cap. Single
user, so none yet.

### Move 3 — the principle

**Separate what's built once from what runs per request, and the per-request path gets cheap and the
expensive setup gets paid once.** A session object is the closure that holds the once-built things and
exposes only the per-turn verbs. The corollary buffr makes explicit: the *order* of the per-turn
steps encodes the reliability guarantees — persist-before-work and flush-before-best-effort aren't
incidental, they're how a turn survives a crash.

## Primary diagram

```
  Long-Lived Chat Session — full picture

  process start
       │
       ▼  createChatSession()  ── ONCE ──────────────────────────────┐
  ┌────────────────────────────────────────────────────────────────┐ │
  │ pool (warm) · embedder · store · pipeline · tool · model ·     │ │
  │ profile (read once) · memory engine · conversationId (one row) │ │
  │ trace sink · agent (built once)                                │ │
  └───────────────────────────────┬────────────────────────────────┘ │
        returns { ask, close } closure ─────────────────────────────┘
                                  │
  ┌─ per turn (chat.tsx → ask) ───▼────────────────────────────────┐
  │ 1 persist user (durable first)                                 │
  │ 2 agent.answer  (reused agent — RAG loop, tool call)           │
  │ 3 trace.flush   (drain trajectory → agents.messages)           │
  │ 4 memory.remember (best-effort, swallowed)                     │
  └────────────────────────────────────────────────────────────────┘
                                  │
  /exit ──► session.close() ──► pool.end()   ── ONCE (teardown)
```

## Elaborate

This is the same shape as a database connection pool or an HTTP keep-alive client: amortize the
expensive setup across many cheap operations. For an agent the "expensive setup" is the pool plus the
whole aptkit wiring graph; the "cheap operation" is a turn. The interesting buffr-specific decision is
collapsing the *conversation* into the session lifetime — one `npm run chat` is exactly one
conversation (`chat.tsx:39-40`: "one conversation, held in-process"). That's a product decision (a
session is a sitting) expressed as an architectural one (one `conversationId` per process).

The build-once decision also interacts with `04`'s boundary: the wiring graph built here is *all*
dependency injection of buffr's adapters into aptkit's factories, done once. So the session is both
the lifecycle owner and the single composition root.

Read next: `03-trajectory-capture.md` (step 3's flush), `04-library-as-dependency-boundary.md` (the
wiring this builds once), `06-profile-injection-as-context.md` (the profile read once at setup). The
event-loop / process mechanics → `study-runtime-systems`.

## Interview defense

**Q: Why build the agent once instead of per request?**
Because the agent's wiring graph — pool, model provider, tool registry, memory engine — is expensive
to construct, and none of it changes between turns. Building it once at session start and closing over
it makes each `ask()` just the per-turn work (`session.ts:39-57` build once, `60-71` run per turn).
The old `npm run ask` rebuilt everything per call; this session is the fix.

```
  build once:  [pool · agent · memory · conversationId]  ← amortized over the session
  per turn:    persist → answer → flush → remember        ← the only repeated cost
```

**Q: What makes it "one conversation"?**
One `conversationId`, created once at session start (`session.ts:55`), referenced by every turn's
trajectory rows. The trajectory and the memory stream are continuous across turns under that single id
— even though the *prompt* doesn't carry turn history (that's deferred to aptkit). Continuity is in the
store, not the prompt window.

**Q: Defend the order of the four steps in `ask`.**
Persist the user turn first so a mid-generation crash still records the question. Flush the trajectory
before the best-effort memory write so the durable record is safe before the optional step. Wrap
`remember` in a swallow so memory failure can't lose the answer the user already has. The ordering is
the crash-recovery design — reorder it and you lose a turn or an answer (`session.ts:60-69`).

## See also

- `03-trajectory-capture.md` — `flush()` at step 3 and the conversation row created here.
- `04-library-as-dependency-boundary.md` — the once-built wiring is the composition root.
- `06-profile-injection-as-context.md` — the profile read once at setup.
- `audit.md` lens 3 (session state in a closure), lens 6 (turn ordering as reliability), red-flag #5.
- `study-runtime-systems` → process lifetime, the warm pool, async ordering.

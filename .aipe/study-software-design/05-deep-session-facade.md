# 05 — Deep session facade

**Industry name(s):** Facade pattern · "deep module" (APOSD) · resource-owning
object · session lifecycle. **Type:** Industry standard.

---

## Zoom out, then zoom in

The chat UI (`chat.tsx`) needs to do exactly two things: ask a question and
get an answer, and shut down cleanly on `/exit`. It should know *nothing*
about pools, embedders, agents, trace sinks, or memory engines. So
`createChatSession` builds all eleven of those collaborators, holds them
across every turn, and hands the UI a two-method object: `ask(q)` and
`close()`.

```
  Zoom out — the facade between the UI and everything else

  ┌─ UI (Ink/React) ──────────────────────────────────────────┐
  │  chat.tsx   session.ask(q) · session.close()               │
  │  knows: turns, busy state, /exit. NOTHING else.            │
  └──────────────────────────┬─────────────────────────────────┘
              ChatSession seam │  { ask, close }  ← 2 methods
  ┌─ buffr ──────────────────▼─────────────────────────────────┐
  │  ★ createChatSession ★   session.ts                        │ ← here
  │  holds: pool·embedder·store·pipeline·tool·registry·model·  │
  │         profile·memory·conversationId·trace·agent (11)     │
  └──────────────────────────┬─────────────────────────────────┘
              ▼ aptkit + Postgres + Ollama
```

Zoom in: a facade is a small interface over a large, multi-part subsystem — the
defining shape of a *deep module*. The depth ratio here is stark: two public
methods, eleven private collaborators, a full per-turn lifecycle. The question:
**what does the facade hold and orchestrate, and why is a deep facade the right
call instead of letting the UI wire it up?**

---

## Structure pass

**Layers.** The UI on top, the facade in the middle, the subsystem below.

```
  one axis traced: "what does the UI have to know?"

  ┌─ UI ────────────────────────┐  knows: ask/close, two methods
  │  chat.tsx                   │
  └──────────────┬──────────────┘
        seam ◄── knowledge collapses here ──►
  ┌─ facade ─────▼──────────────┐  knows: the entire wiring + lifecycle
  │  createChatSession          │
  └──────────────┬──────────────┘
  ┌─ subsystem ──▼──────────────┐  pool, agent, memory, trace, Ollama, pg
  │  aptkit + Postgres + Ollama │
  └──────────────────────────────┘
```

**Axis — "what does the UI have to know?"** Above the facade: two methods.
Below: eleven collaborators and a four-step per-turn sequence. **The
knowledge collapses at the facade seam** — that collapse, from eleven things
to two, *is* the depth. The bigger the gap between interface and body, the
deeper the module.

**Seam.** The `ChatSession` type (`session.ts:29-32`) is the contract:
`{ ask(question): Promise<string>; close(): Promise<void> }`. `chat.tsx` is
typed against it (`:5,9`) and never imports anything else from the subsystem.
The seam is two methods wide; everything else is hidden behind it.

---

## How it works

### Move 1 — the mental model

You know how a `useQuery` hook hands your component `{ data, loading, error }`
and hides the fetch, the cache, the retry, the abort controller? The component
calls one hook and gets a clean surface; the machinery is the hook's problem.
`createChatSession` is that for a whole agent session: the UI gets `ask` and
`close`, and the eleven-object subsystem is the facade's problem. The strategy:
**construct the world once, hold it, expose a verb or two over it.**

```
  the facade — narrow surface, held subsystem, per-turn loop

   ask(q) ──┐                                  ┌── close()
            ▼                                  ▼
   ┌─────────────────────────────────────────────────┐
   │  HELD across turns (built once at construct):     │
   │   pool · embedder · store · pipeline · tool ·     │
   │   registry · model · profile · memory ·           │
   │   conversationId · trace · agent                  │
   │                                                   │
   │  PER ask(): persist → answer → flush → remember   │
   └─────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — construct the world once (what breaks: per-turn cold starts).**

**File:** `src/session.ts` · **Function:** `createChatSession` · **Lines:**
39-57.

```ts
const pool     = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: '...', host: cfg.ollamaHost });
const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
const tool     = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools    = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
const model    = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 });
const profile  = await loadProfile(pool, cfg.appId);
const memory   = createConversationMemory({ embedder, store });
const conversationId = await startConversation(pool, cfg.appId);
const trace    = new SupabaseTraceSink({ pool, conversationId });
const agent    = new RagQueryAgent({ model, tools, profile, trace });
```

Eleven collaborators, built once, *before* the first question. The comment at
`:13-17` names the win: "one warm pg pool and one conversation held across
every turn (unlike the one-shot `ask` CLI, which opens and closes per call)."
The old `npm run ask` rebuilt all of this per question — cold pool, new
conversation row every time. The facade holds it, so turn two reuses the warm
pool and writes into the *same* conversation. Strip the "hold it" property and
you're back to per-turn cold starts and a fragmented trajectory. **This is the
depth paying off: the lifecycle is the hidden value.**

**Part 2 — the per-turn sequence (what breaks: lost answers / lost
trajectory).**

**File:** `src/session.ts` · **Function:** `ask` · **Lines:** 60-71.

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // 1. record the question
  const answer = await agent.answer(question);                   // 2. run the agent (emits trace)
  await trace.flush();                                           // 3. drain the trajectory queue
  try {
    await memory.remember({ conversationId, question, answer }); // 4. episodic memory (best-effort)
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
  return answer;
}
```

Four ordered steps behind one method call. Read the ordering — it's the design:

```
  the per-turn pipeline — order matters

  1 persist user ─► 2 agent.answer ─► 3 flush trace ─► 4 remember
    (durable           (emits steps      (drain queue      (best-effort,
     before run)        synchronously)    → see file 04)     swallowed)
                                                              │
                              the answer is already returned ─┘
                              before remember can fail
```

- **Step 1 before step 2:** the question is durable *before* the agent runs, so
  a crash mid-run still has the user turn recorded.
- **Step 3 after step 2:** flush drains the trace sink's queue (file 04) — the
  emits happened *inside* `answer()`, so flush has to come after.
- **Step 4 wrapped in try/catch:** memory is best-effort. The comment is
  explicit — "a memory-write failure must not lose the answer the user has."
  The answer is computed at step 2; step 4 can fail and the user still gets
  their answer. This is "define errors out of existence" (audit §6): a memory
  failure simply isn't a failure of the turn.

**Load-bearing: the ordering and the swallow are the contract.** Reorder these
and you lose the durability guarantee or you let a non-fatal memory write sink
the whole turn.

**Part 3 — the narrow surface the UI sees (what breaks: leaking the
subsystem).**

**File:** `src/session.ts:29-32` (the type) and `src/cli/chat.tsx:15-35` (the
consumer).

```ts
export type ChatSession = {
  ask(question: string): Promise<string>;
  close(): Promise<void>;
};
```

`chat.tsx` does `await session.ask(q)` (`:28`) and `await session.close()`
(`:19`) and nothing else. It never sees `pool`, `agent`, `trace`, or `memory`.
That's the facade's payoff: the UI is a pure rendering concern — turns, busy
spinner, `/exit` — and the entire agent subsystem is sealed behind two methods.
Widen this interface (expose the pool, say) and the UI starts coupling to the
subsystem, and the seam stops protecting either side. **The narrowness is the
whole point.**

### Move 3 — the principle

A deep module earns its depth by the ratio of what it hides to what it shows.
`createChatSession` shows two methods and hides eleven collaborators plus a
four-step lifecycle with ordering that matters. The right time to build a
facade is exactly this: when a subsystem has real lifecycle (warm resources,
held state, ordered teardown) that a caller would otherwise have to manage
correctly every time. Don't make the caller orchestrate the world — orchestrate
it once, hold it, and hand back a verb.

---

## Primary diagram

The facade, its held subsystem, and the per-turn loop, in one frame.

```
  createChatSession — deep facade over the agent subsystem

  ┌─ UI: chat.tsx ──────────────────────────────────────────────────┐
  │  session.ask(q) ──┐                       ┌── session.close()     │
  └───────────────────┼───────────────────────┼──────────────────────┘
                      │  ChatSession (2 methods)│
  ┌─ facade: createChatSession ────────────────┼──────────────────────┐
  │  built ONCE, held across turns:                                    │
  │  ┌──────────────────────────────────────────────────────────────┐ │
  │  │ pool · embedder · store · pipeline · tool · registry · model │ │
  │  │ · profile · memory · conversationId · trace · agent          │ │
  │  └──────────────────────────────────────────────────────────────┘ │
  │  per ask():  ① persist user ─► ② agent.answer ─► ③ flush ─► ④ remember
  │              durable           emits trace      drain      best-effort│
  │  close():    pool.end()                                              │
  └──────────────────────┬──────────────────────────────────────────────┘
            ▼ aptkit (RagQueryAgent) · Postgres (warm pool) · Ollama
```

---

## Elaborate

The Facade is GoF: a unified, simplified interface over a complex subsystem.
APOSD reframes it as the canonical *deep module* — the highest-value design
move in the book, because depth is what stops complexity from amplifying
upward. The session also does resource ownership (RAII-ish): it constructs the
pool, holds it, and `close()` ends it (`:72-74`), so the lifetime of every
resource is bounded by the lifetime of the session object.

This is the same shape as the `useQuery`-style hooks you build in React —
construct the machinery once, hand the component a tiny surface — but lifted to
a whole agent session. The `ask` CLI it replaced (context.md: "the old one-shot
`npm run ask` was removed") was the *shallow* version: it rebuilt the world per
call, so there was no held state to hide and no facade to be deep. Adding the
chat UI created the need for a long-lived session, and that need is what makes
the deep facade the right call.

Read next: `04-sync-interface-async-work.md` (the `flush` step), and
`03-dependency-as-a-boundary.md` (the injection that fills the subsystem).

---

## Interview defense

**Q: Why a session object instead of letting the UI build the agent and call
it directly?**
Because the subsystem has real lifecycle the UI shouldn't manage: a warm pool
reused across turns, one conversation row spanning the session, an ordered
per-turn pipeline (persist → answer → flush → remember), and clean teardown. If
the UI wired that up, it'd couple to eleven collaborators and would have to get
the ordering right every render. The facade does it once and hands back two
methods, so the UI stays a pure rendering concern.

```
  depth = hidden ÷ shown

  shown:   ask, close                    (2)
  hidden:  11 collaborators + 4-step      → deep module:
           per-turn lifecycle + teardown    the UI never sees it
```

**Q: What's the most important detail in `ask` that's easy to miss?**
The ordering, and specifically that `remember` is wrapped in try/catch and
swallowed. The answer is computed by step 2; steps 3 and 4 are persistence and
memory. Memory is best-effort — a failed memory write must not lose the answer
the user already has — so it's swallowed deliberately (`session.ts:64-69`).
That's the difference between "the turn failed" and "a non-essential side
effect failed," and getting it wrong would surface memory hiccups as turn
errors.

**Anchor:** "A deep facade orchestrates lifecycle once and hands back a verb,
so the caller never manages the subsystem."

---

## See also

- `audit.md` §2 (deep vs shallow — this is the runner-up deep module), §6.
- `01-adapter-behind-a-contract.md` — the `PgVectorStore` the facade holds.
- `03-dependency-as-a-boundary.md` — the injection wiring inside the facade.
- `04-sync-interface-async-work.md` — the `flush` the per-turn loop calls.

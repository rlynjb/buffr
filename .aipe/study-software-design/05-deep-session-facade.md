# Deep session facade — createChatSession behind ask() / close()

**Industry names:** the facade pattern · a deep module · the session
object · resource-holding object (RAII-ish). **Type:** Industry standard.

Eleven constructed things — embedder, store, pipeline, tool, registry,
model, profile, memory engine, conversation, trace sink, agent — wired
together once and held warm across a whole conversation, all hidden behind
a two-verb interface: `ask(question)` and `close()`. This is the deepest
*facade* in buffr: the most wiring behind the narrowest door. The UI
(`cli/chat.tsx`) drives an entire RAG agent with persistent trajectory and
episodic memory using exactly those two methods.

Role-vocabulary (facade + deep module), named once:

- **the facade** — the `ChatSession` interface (`session.ts:29-32`):
  `ask` / `close`. The narrow door.
- **the subsystem** — the eleven wired pieces behind it (the agent,
  pipeline, store, memory, trace, pool, conversation).
- **the client** — `cli/chat.tsx`, the Ink UI; it holds a `ChatSession`
  and calls only the two methods.
- **the resource** — the warm `pg.Pool` + the single `conversationId`
  held across turns; what `close()` releases.

---

## Zoom out, then zoom in

The facade sits between the UI and the entire agent subsystem. The UI knows
two verbs; everything else is behind the door.

```
  Zoom out — the facade between UI and subsystem

  ┌─ UI layer (Ink / React) ─────────────────────────────────────┐
  │  cli/chat.tsx   →   session.ask(q)   ·   session.close()      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ TWO methods only (the facade door)
  ┌─ Session facade ──────────▼──────────────────────────────────┐ ← here
  │  ★ createChatSession() ★  holds, warm, across every turn:     │
  │   pool · embedder · store · pipeline · tool · registry ·      │
  │   model · profile · memory · conversationId · trace · agent   │
  │   ask(): persist → answer → flush → remember                  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ orchestrates aptkit + Postgres
  ┌─ aptkit + Storage ────────▼──────────────────────────────────┐
  │  RagQueryAgent · RetrievalPipeline · memory · agents.* tables │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a facade gives a simple interface to a complicated subsystem. What
makes *this* facade deep — not just a thin wrapper — is that it doesn't only
*simplify* the subsystem, it *owns lifecycle*: it builds the eleven pieces
once, holds the expensive ones warm (the pool, the conversation) across
every `ask`, and tears them down on `close`. The client never sees a pool,
never sees a `conversationId`, never sees aptkit. Two verbs, an entire
stateful agent behind them.

---

## The structure pass

**Layers:** UI (Ink) · the `ChatSession` facade · the agent subsystem
(aptkit) · storage (Postgres).

**The axis: what lives for one turn vs the whole session?** This is the
axis that makes the facade *deep* rather than thin — trace lifetime across
the door:

```
  axis traced = "how long does this live?"

  ┌─ cli/chat.tsx ──┐ seam  ┌─ createChatSession ──────────────┐
  │ holds session   │ ══╪══►│ SESSION-lifetime (built once):   │
  │ for whole chat  │      │   pool · agent · conversationId   │
  │ (knows nothing  │      │ ───────────────────────────────── │
  │  about either)  │      │ TURN-lifetime (per ask()):        │
  └─────────────────┘      │   question · answer · flush        │
                           └────────────────────────────────────┘
       the facade owns BOTH lifetimes; the client sees NEITHER
```

The axis flips at the door and *again inside the facade*: the client has one
lifetime (the chat), but the facade internally distinguishes
session-lifetime resources (built once, in `createChatSession`'s body,
`:34-57`) from turn-lifetime work (inside `ask`, `:60-71`). Holding the
expensive things at session lifetime — one warm pool, one conversation — is
the design choice the facade exists to make. A thin wrapper wouldn't; it'd
rebuild per call.

---

## How it works

### Move 1 — the mental model

You know this from frontend: a custom hook like `useChat()` that returns
`{ send, reset }`. Inside, it wires up state, a websocket, retry logic,
optimistic updates — but the component using it sees two functions. The
hook is a facade over a subsystem, and it *holds state across renders*. `c
reateChatSession` is the server-side equivalent: it wires a subsystem and
returns two methods, holding state across turns instead of renders.

In one sentence: **build the expensive subsystem once, hold the warm
resources across turns, and expose only the verbs the client actually
needs.**

```
  Deep facade — wiring hidden, lifecycle owned

  createChatSession()
    ├─ build once (session lifetime): pool, agent, conversation
    └─ return { ask, close }              ← the narrow door
                  │
         ask(q) ──┤ persist → answer → flush → remember  (per turn)
         close() ─┘ pool.end()                            (once)
```

### Move 2 — the walkthrough

**1. Build once — the subsystem is wired before any turn.** The body of
`createChatSession` (`session.ts:34-57`) constructs the whole stack a single
time. The expensive parts — the pool, the loaded profile, the conversation
row — are paid for once, not per question:

```ts
// session.ts:39-57 (condensed — the build-once block)
const pool = createPool(cfg.databaseUrl);                       // warm pool, held
const embedder = new OllamaEmbeddingProvider({ ... });
const store = new PgVectorStore({ pool, appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { ... });
const model = new ContextWindowGuardedProvider(new GemmaModelProvider({ ... }), { maxTokens: 8192 });
const profile = await loadProfile(pool, cfg.appId);             // loaded once
const memory = createConversationMemory({ embedder, store });
const conversationId = await startConversation(pool, cfg.appId);// ONE conversation, held
const trace = new SupabaseTraceSink({ pool, conversationId });
const agent = new RagQueryAgent({ model, tools, profile, trace });// built once
```

Eleven constructions, all behind the door. The class comment at
`session.ts:13-28` names the design contrast directly: "one warm pg pool and
one conversation held across every turn (unlike the one-shot `ask` CLI,
which opens and closes per call)." That's the deep-facade thesis — the
removed one-shot CLI rebuilt per call; this holds.

**2. `ask` — the turn, four steps behind one verb.** The client calls
`ask(q)`; behind it, four ordered operations the client never sees:

```ts
// session.ts:60-71 (the per-turn body)
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // 1. record the user turn
  const answer = await agent.answer(question);                   // 2. run the agent (emits trace)
  await trace.flush();                                           // 3. drain the trajectory writes
  try {
    await memory.remember({ conversationId, question, answer }); // 4. episodic memory (best-effort)
  } catch {
    // swallow: memory is best-effort, the turn already succeeded
  }
  return answer;
}
```

```
  Layers-and-hops — one ask() across the subsystem

  ┌─ UI ─────┐ ask(q)  ┌─ facade ────────────────────────────────┐
  │ chat.tsx │ ──────► │ 1 persist user  ──► agents.messages      │
  │          │ ◄────── │ 2 agent.answer  ──► aptkit loop (+trace) │
  └──────────┘ answer  │ 3 trace.flush   ──► drain trajectory     │
                       │ 4 memory.remember ─► agents.chunks (best │
                       │    (try/catch, swallow on fail)  effort) │
                       └──────────────────────────────────────────┘
```

The ordering is load-bearing. Persist-first (step 1) means the user's
question is recorded even if the agent crashes. Flush-before-return (step 3)
means the trajectory is durable before the UI shows the answer. Memory-last
and swallowed (step 4) means a memory failure never costs the user the
answer they already have — the comment at `:67-68` names exactly that:
"a memory-write failure must not lose the answer the user has." (Errors
audit: lens 6.)

**3. `close` — the resource teardown, one line.** The only other verb:

```ts
// session.ts:72-74
async close(): Promise<void> {
  await pool.end();           // release the warm pool — the held resource
}
```

`close` is the counterpart to build-once: the warm pool held for the whole
session is released here. The UI calls it on `/exit` (`cli/chat.tsx:18-21`).
This is the resource-holding half of the facade — the session *owns* the
pool's lifetime, so the client doesn't have to.

**4. The client sees the door, nothing else.** `cli/chat.tsx` is the proof
the facade works — it drives the entire agent with two calls:

```ts
// cli/chat.tsx:18-29 (condensed)
if (q === '/exit' || q === '/quit') { await session.close(); exit(); return; }
// ...
const answer = await session.ask(q);   // ← the whole subsystem, one call
```

No pool, no `conversationId`, no aptkit import, no trace, no memory in the
UI file. The UI's entire knowledge of the backend is `ask` and `close`.
That's the depth: maximum subsystem, minimum surface.

### Move 3 — the principle

A facade is worth building when the *interface* it exposes is dramatically
smaller than the *subsystem* it hides — and it becomes a *deep* facade when
it also owns the subsystem's lifecycle, so the client never manages
resources. `createChatSession` hides eleven constructions and three storage
tables behind two verbs, and it owns the warm pool and the single
conversation across the whole session. The client (`cli/chat.tsx`) is
correspondingly thin — it can't leak a connection or fragment a
conversation across turns, because it never holds either. The general rule:
**push the wiring and the lifecycle into the facade; hand the client only
the verbs.** The narrower the door and the more it owns behind it, the
harder the client is to misuse.

---

## Primary diagram

```
  createChatSession — the deep facade, full recap

  ┌─ UI: cli/chat.tsx (thin client) ─────────────────────────────┐
  │  session.ask(q)            session.close()                    │
  └───────────────────────────┬──────────────────────────────────┘
                  TWO verbs    │  the facade door
  ┌─ Facade: createChatSession ▼─────────────────────────────────┐
  │  BUILD ONCE (session lifetime):                              │
  │   pool ─ embedder ─ store ─ pipeline ─ tool ─ registry ─     │
  │   model ─ profile ─ memory ─ conversationId ─ trace ─ agent  │
  │                                                              │
  │  ask(q)  →  1 persist user                                   │
  │            2 agent.answer (emits trace events)               │
  │            3 trace.flush  (drain trajectory)                 │
  │            4 memory.remember (best-effort, swallowed)        │
  │  close() →  pool.end()  (release the warm resource)          │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  ┌─ aptkit + Postgres ──────────────────────────────────────────┐
  │  RagQueryAgent · pipeline · memory · agents.{messages,        │
  │  conversations, chunks}                                       │
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The facade pattern (Gang of Four) gives a unified, simpler interface to a
set of interfaces in a subsystem. Ousterhout's framing sharpens it: a facade
is good exactly when it's a *deep* module — a small interface over
substantial behaviour. A thin facade that just forwards each subsystem call
one-to-one is classitis; it adds a layer without hiding anything. `create
ChatSession` avoids that by hiding *orchestration* (the four-step turn) and
*lifecycle* (build-once, hold-warm, close), not just renaming methods.

The resource-holding angle connects to RAII (C++) and `using`/`defer`
(C#/Go): an object that acquires a resource on construction and releases it
on a known teardown call. buffr's version is the async pair
`createChatSession()` / `close()` — acquire the pool when you build the
session, release it when you close. The UI's `/exit` handler
(`cli/chat.tsx:18-21`) is the disciplined teardown.

This facade is the client side of three other patterns in this guide: it
*constructs* the adapter (`01-adapter-behind-a-contract.md`), *injects*
everything up into aptkit (`03-dependency-as-a-boundary.md`), and *flushes*
the observer (`04-sync-interface-async-work.md`). It's where the whole
system is wired.

---

## Interview defense

**Q: Is `createChatSession` a facade or a god object?** A facade — and the
distinction is what it *exposes*, not what it *holds*. It holds eleven
things, but it exposes two verbs and owns one clear responsibility: run a
conversation. A god object exposes its internals and accretes unrelated
duties; this hides every internal behind `ask`/`close` and does exactly one
job. The eleven constructions aren't sprawl — they're a subsystem wired once
and hidden. The tell is the client: `cli/chat.tsx` imports none of the
eleven.
*Anchor:* "eleven things held, two verbs exposed — a god object leaks its
internals; this hides all of them."

```
  facade (deep)                god object (shallow)
  ┌──────────────┐             ┌──────────────┐
  │ 11 held      │             │ 11 exposed   │
  │ 2 exposed    │             │ + unrelated  │
  │ 1 job        │             │ duties       │
  └──────────────┘             └──────────────┘
```

**Q: Why hold the pool and conversation across turns instead of per `ask`?**
Cost and coherence. The pool is expensive to open (TCP + auth), so opening
it once and holding it warm saves that cost on every turn after the first —
the comment at `session.ts:13-18` contrasts this with the removed one-shot
CLI that opened and closed per call. The single `conversationId` is about
coherence: every turn's messages and trajectory land in *one* conversation
row, so the trajectory is a continuous thread, not fragments. Per-`ask`
construction would scatter the conversation and re-pay the pool cost each
time.
*Anchor:* "warm pool for cost, one conversation for coherence — both are
session-lifetime, so they live in the facade's body, not in ask()."

**Q: Why is `memory.remember` wrapped in a swallow but the agent run isn't?**
Because they have different failure contracts. If `agent.answer` throws,
there's no answer to return — the failure is the turn. If `memory.remember`
throws, the user already has their answer; failing the turn over a best-
effort episodic write would be strictly worse. So memory is last and
swallowed (`session.ts:64-69`), agent is not. The ordering encodes the
priority: do the thing that can lose data first, do the thing that's
optional last and let it fail quietly.
*Anchor:* "the swallow is deliberate — memory is best-effort, so its failure
is defined to not cost the user the answer."

---

## See also

- `01-adapter-behind-a-contract.md` — the `PgVectorStore` this facade
  constructs.
- `03-dependency-as-a-boundary.md` — the injection wiring done in the
  build-once block.
- `04-sync-interface-async-work.md` — the `trace.flush()` called in `ask`.
- `audit.md` lenses 2 (depth), 6 (the deliberate memory swallow).
- `study-system-design/` — the request/turn flow at the architecture
  altitude.

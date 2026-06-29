# Cross-Turn Caching

*Industry names: **prompt caching** (provider-side prefix cache) / **memoization**
(intra-run) / **semantic caching** (cross-run). Type label: Industry standard. In buffr: the
prefix SHAPE is present (the stable system prompt leads every turn); the billed cache is NOT
YET (local Ollama doesn't bill); the cross-run cache is NOT YET (each run is a fresh
conversation). The connection-reuse cousin — the warm pg pool — IS implemented.*

## Zoom out, then zoom in

```
  buffr's serving stack — caching wraps the loop at three radii

  ┌─ CROSS-RUN (semantic cache) ─ across separate `npm run chat` runs ──┐  NOT YET
  │  same/similar question asked twice → reuse the prior answer         │
  │ ┌─ ★ CROSS-TURN (prompt-prefix cache) ★ ─ within one run ────────┐  │  SHAPE yes, BILL no
  │ │  stable system prompt re-sent at the FRONT of every turn       │  │
  │ │ ┌─ INTRA-RUN (memoization) ─ within one turn's tool calls ───┐ │  │  NOT YET
  │ │ │  same tool + same args → reuse the result, don't re-call   │ │  │
  │ │ │ ┌─ THE LOOP ─ run-agent-loop.ts:76-202 ──────────────────┐ │ │  │
  │ │ │ │  model.complete(system, messages) — once PER TURN      │ │ │  │
  │ │ │ └─────────────────────────────────────────────────────────┘ │ │  │
  │ │ └─────────────────────────────────────────────────────────────┘ │  │
  │ └─────────────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────────────┘
```

A single LLM call caches one thing: the request. A *loop* re-issues a request every turn, and
each turn re-sends the same stable prefix — profile + instructions — at the front. That
front-loaded stability is the prompt-prefix-cache shape (★ marks it), and it exists in buffr's
`messages` array whether or not the provider bills for it. The three radii above are the same
idea applied at three distances: within a turn, across turns, across runs.

## Structure pass

Three cache layers, traced along ONE axis: **how far the reuse reaches**.

```
  Axis = REUSE DISTANCE · trace how far each cache layer carries a result forward

  INTRA-RUN memoization     reach = within one turn   same tool+args → skip the re-call
  ────────────────────────────────────────────────────────────────────────────────────
  CROSS-TURN prefix cache   reach = across turns       stable front of `messages` reused
  ──────────────── ★ SEAM: in-process vs provider-side ★ ──────────────────────────────
  CROSS-RUN semantic cache  reach = across runs        same question → reuse the answer
```

The seam is *who owns the cache*. Above it, memoization and semantic caching are **your**
code — a `Map`, a vector lookup you write. The prefix cache below the conceptual front is
**the provider's** — you don't store anything; you just keep the prefix byte-identical and the
provider recognizes it. buffr's prefix is structurally cacheable (`run-agent-loop.ts:94,124` —
profile + instructions lead the array) but local Ollama is the provider, and it doesn't bill,
so there is no win to capture today.

## How it works

### Move 1 — mental model

A cache is a bet that you will pay the same cost twice. The frontend reflex: keep the *stable
part* of a request stable so an HTTP cache can reuse it — same URL, same headers, the response
comes from cache instead of the origin. Prompt-prefix caching is exactly that bet at the token
level: keep the front of the prompt byte-identical across turns, and the provider reuses the
already-computed attention state for that prefix instead of recomputing it.

```
  THE SHAPE — keep the front stable so the cache can reuse it

  HTTP cache:   GET /v1/profile  (stable URL+headers)  → cache HIT → skip origin
  PREFIX cache: [stable system prompt][growing messages] → cache HIT on the prefix → skip recompute
                 └─────── reused ──────┘└── recomputed ──┘
```

### Move 2 — the three layers

**Cross-turn: the prefix cache (the shape buffr has, the bill it doesn't).**

Every turn, the loop calls `model.complete` with the same `system` and a `messages` array that
only ever grows at the tail. The stable system prompt — profile + instructions — sits at the
front and never changes. That is the prefix-cache shape: the expensive, repeated part is
front-loaded and stable.

```
  CROSS-TURN — the stable prefix leads every turn (the cacheable front)

  turn 0:  [SYSTEM: profile+instructions] [user q]
  turn 1:  [SYSTEM: profile+instructions] [user q][assistant][tool_result]
  turn 2:  [SYSTEM: profile+instructions] [user q][assistant][tool_result][assistant][tool_result]
            └──────── IDENTICAL prefix ────────┘ └──────────── grows at the TAIL ─────────────┘
              ↑ a billed provider reuses THIS               ↑ only this is recomputed
```

```ts
// @aptkit/runtime — run-agent-loop.ts:94,124 — the stable prefix is structural, not added by you.
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];   // :94 — array seeded
// ...each turn, inside the for-loop:
const response = await model.complete({
  system,                 // ← profile + instructions: IDENTICAL every turn = the cacheable prefix
  messages,               // ← grows at the TAIL only (assistant + tool_result appended below)
  tools: forceFinal ? undefined : toolSchemas,
  maxTokens,
});
messages.push({ role: 'assistant', content: response.content });            // :124 — append, never rewrite the front
```

Annotation: nothing in buffr *configures* a cache here — the win is free if it exists, because
the shape is already correct. On a billed provider (Anthropic, OpenAI) you would mark the
stable prefix as cacheable and pay a fraction for those tokens on turns 1..N. On local Ollama
the model recomputes every turn but you aren't billed, so there's no money on the table — the
shape is right, the win is absent. **buffr's would-need: move to a billed provider, and this
prefix becomes real per-turn savings with zero code change to the array.** (Mechanics of how
the bill works: `study-ai-engineering/06-production-serving/`.)

**Intra-run: memoization (NOT YET — and barely needed).**

Within one run, if the agent called the *same tool with the same args* twice, you could skip
the second call and reuse the first result. That's plain memoization — a `Map` keyed on
`(toolName, args)`.

```
  INTRA-RUN — same tool+args → serve from memory, don't re-execute

  callTool("search_knowledge_base", {q:"X"})  → MISS → execute → store under key (name, {q:"X"})
  callTool("search_knowledge_base", {q:"X"})  → HIT  → return stored result, skip pgvector
```

Bridge from primitive: it's `Promise.all()` you'd dedupe — same as wrapping a `fetch` in a
`Map<url, Promise>` so two callers for the same URL share one in-flight request. buffr doesn't
wire this because `maxToolCalls:4` already caps the loop at four tool calls total, and the
agent rarely repeats an identical query inside one run. **buffr's would-need: a longer
iteration budget or a planner that re-issues identical sub-queries — then memoization stops
being noise.**

**Cross-run: semantic caching (NOT YET — no shared store across runs).**

Across separate runs, if a new question is semantically close to one already answered, you
could return the cached answer and skip the whole loop. That's a semantic cache: embed the
question, vector-lookup against past (question → answer) pairs, return on a near hit.

```
  CROSS-RUN — embed the new question, reuse a near-identical prior answer

  new question ─▶ embed ─▶ vector lookup over (past_question → answer) pairs
                              │ similarity ≥ threshold?
                  ┌── yes ────┴──── no ──┐
                  ▼                       ▼
            return cached answer    run the full loop (then cache this pair)
            (skip the loop)
```

But each `npm run chat` run starts a **fresh conversation** — `startConversation`
(`session.ts:55`) opens a new conversation id every run, and the loop is seeded empty
(`run-agent-loop.ts:94`). There is no cross-run answer cache today. (buffr *does* persist
episodic memory across runs via `createConversationMemory`, but that surfaces past exchanges as
*retrieval* inside a fresh loop — it is recall, not a cache that short-circuits the loop.)
**buffr's would-need: a (question-embedding → answer) table consulted before the loop runs.**

**The connection-reuse cousin buffr DOES have: the warm pg pool.**

Not a token cache, but the same serving instinct — *don't re-pay a setup cost you'll pay every
turn*. buffr holds ONE `pg` `Pool` across the whole session instead of opening a connection per
turn.

```
  WARM POOL — one connection set, reused across every turn (the fetch keep-alive analogue)

  createPool() ──once──▶ ┌─ Pool (warm) ─┐  turn 0 ─┐
                         │  connections   │  turn 1 ─┼─▶ borrow → query → return (no reconnect)
                         │  kept open     │  turn N ─┘
                         └────────────────┘
  pool.end() ──on close──▶ drained
```

```ts
// src/session.ts:39 — the warm pool, created ONCE for the whole session.
const pool = createPool(cfg.databaseUrl);     // every turn's pgvector query borrows from THIS
// ...all turns reuse `pool` (PgVectorStore, profile load, persistMessage, trace) ...
// src/session.ts:73 — drained only when the session closes.
async close(): Promise<void> { await pool.end(); }
```

Annotation: this is the direct analogue of a `fetch` with HTTP keep-alive — the TCP/TLS
handshake is paid once and the connection is reused for every subsequent request. The
one-shot `ask` CLI opens and closes per call; the *session* keeps the pool warm because it
knows it will run many turns. This is the connection-reuse serving win buffr actually ships.

### Move 3 — the principle

**Cache the part that repeats, at the radius it repeats — and never cache a thing that can go
stale inside a trajectory.** The prefix repeats every turn (cache it at the provider). A
connection repeats every turn (reuse it — the warm pool). An answer might repeat across runs
(semantic cache, if you have a shared store). The sharp edge is the cross-run cache: a single
LLM call that serves a stale cached answer is one wrong response, but an agent that reads a
stale cached answer at the *start* of a loop poisons the **whole trajectory** — every
subsequent turn reasons off a wrong premise. The blast radius of a stale cache scales with the
length of the loop, not with one call.

## Primary diagram

The three radii plus the warm-pool cousin, with buffr's status on each.

```
  Cross-turn caching in buffr — three radii + the connection cousin

  CROSS-RUN  semantic cache    embed question → reuse prior answer    NOT YET (fresh conv :55)
  ─────────────────────────────────────────────────────────────────────────────────────────
  CROSS-TURN prefix cache      stable system prompt leads :94,:124    SHAPE yes · BILL no (local)
  ─────────────────────────────────────────────────────────────────────────────────────────
  INTRA-RUN  memoization       same tool+args → reuse result          NOT YET (maxToolCalls:4 caps it)
  ─────────────────────────────────────────────────────────────────────────────────────────
  COUSIN     warm pg pool      one connection set reused :39,:73       IMPLEMENTED (the real win)

  Sharp edge: a stale CROSS-RUN hit poisons the WHOLE trajectory, not just one call.
```

The shape is right at every radius; the only *captured* win today is the warm pool. The rest
flips on the day buffr moves to a billed provider or grows a shared answer store.

## Elaborate

The three radii fail differently, and conflating them is a common interview slip. The prefix
cache is *safe* — its content is your own stable system prompt, so a hit is always correct; the
only question is whether the provider bills cheaply for it. The semantic cache is *dangerous* —
its content is a prior *answer*, which can be stale, wrong, or about a subtly different
question that merely embeds close; that's why it poisons trajectories. Memoization sits between:
safe within one run (the world doesn't change mid-loop for a read tool) but unsafe to persist
across runs (the knowledge base may have re-indexed). The radius determines the staleness risk.

The fleet shape of this is where caching becomes real money. On a billed provider serving many
users, the prefix cache turns the shared system prompt into a once-paid cost amortized across
every turn of every user — and at fleet scale a shared semantic cache in front of the loop can
deflect a large fraction of requests before they ever hit the model. buffr is single-user on a
free local model, so neither earns its keep yet; the warm pool is the one connection-reuse win
that pays off even at N=1, because the setup cost is per-turn regardless of user count.

Cross-ref `study-ai-engineering/06-production-serving/` for the call-level prompt-caching
mechanics (how the provider marks and bills a cached prefix) and
`study-ai-engineering/01-llm-foundations/06-token-economics.md` for why a cached prefix is
money — the per-token cost model a hit avoids.

## Interview defense

**Q: "Do you cache anything in your agent? Why or why not?"**

Model answer: "Three radii, and I'm honest about which are real. The prefix-cache *shape* is
already there — my loop re-sends the same system prompt (profile + instructions) at the front
of the `messages` array every turn (`run-agent-loop.ts:94,124`), which is exactly the
front-stable shape a billed provider would cache. But I run local Ollama, which doesn't bill,
so there's no win to capture today — the shape is right, the savings are absent until I move to
a billed provider, at which point it's free money with zero array changes. Intra-run
memoization and a cross-run semantic cache I deliberately don't have: `maxToolCalls:4` caps
repeat tool calls, and each run starts a fresh conversation (`session.ts:55`) so there's no
cross-run answer to reuse. The one cache cousin I *do* ship is the warm pg pool
(`session.ts:39,73`) — one connection set reused across every turn, the keep-alive win that
pays off even at one user. The trap I'd avoid is a cross-run semantic cache: a stale hit there
doesn't ruin one answer, it poisons the whole trajectory, because every later turn reasons off
the wrong premise."

```
  The defense in one picture

  prefix cache?   shape YES (system prompt leads every turn :94,:124) · bill NO (local Ollama)
  memoization?    NO — maxToolCalls:4 caps repeats
  semantic cache? NO — fresh conversation per run (:55); and a stale hit poisons the trajectory
  warm pool?      YES — one connection reused across turns (:39,:73), the real win
```

Anchor: *Prefix-cache shape present (stable system prompt at the front, `run-agent-loop.ts:94,124`)
but unbilled on local Ollama; no memoization (`maxToolCalls:4` caps it) and no cross-run semantic
cache (fresh conversation per run, `session.ts:55`) — and a stale cross-run hit would poison the
whole trajectory; the one captured win is the warm pg pool (`session.ts:39,73`), the keep-alive
cousin.*

## See also

- `02-fan-out-backpressure.md` — the other serving control that scales with N; caching reduces
  the per-call cost, backpressure bounds the call *rate*.
- `03-per-tool-circuit-breaking.md` — the third serving control; a breaker that opens means a
  cache miss can't even reach the dependency.
- `../04-agent-infrastructure/01-context-engineering.md` — the `messages` array whose stable
  front *is* the cacheable prefix.
- `../04-agent-infrastructure/02-agent-memory-tiers.md` — episodic memory (retrieval-recall)
  vs a semantic answer cache: recall feeds the loop, a cache short-circuits it.
- `study-ai-engineering/06-production-serving/` — the call-level prompt-caching mechanics and
  billing this file points back to.
- `study-ai-engineering/01-llm-foundations/06-token-economics.md` — why a cached prefix is money.

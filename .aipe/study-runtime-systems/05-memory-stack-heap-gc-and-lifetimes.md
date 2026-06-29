# Memory, Stack, Heap, GC, and Lifetimes — what stays alive across a turn

**Industry name(s):** V8 heap & GC, closure capture, object lifetime/reachability · **Type:** Industry standard (JS runtime)

## Zoom out, then zoom in

JavaScript hands you automatic memory: you never `free`. The question that replaces it is *reachability* — an object lives as long as something can still reach it, and dies (eventually) when nothing can. In buffr, the interesting lifetimes are the ones that span the whole chat session: a closure that captures the pool and outlives every turn, and a `turns[]` array that grows for as long as the chat runs.

```
  Zoom out — what holds memory, and for how long

  ┌─ Process-lifetime heap (chat session) ───────────────────────┐
  │  session closure: pool, agent, conversationId, memory engine │ ← lives until close()
  │  React state: turns[] (grows every exchange)                 │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  per-turn allocations:
  ┌─ Turn-lifetime heap ──────────▼───────────────────────────────┐
  │  the 768-float embedding arrays, the vector text literal,     │ ← reachable only
  │  hit rows, jsonb strings, trace pending[] promises            │   during the turn,
  └───────────────────────────────┬───────────────────────────────┘   then collectible
                                  │
  ┌─ The stack (one thread) ──────▼───────────────────────────────┐
  │  call frames; unwinds at each await, rebuilt on resume        │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the axis is *lifetime* — what's allocated once and held, vs. what's allocated per turn and dropped. Get that split right and you can predict buffr's memory shape without a profiler.

## Structure pass

**Layers.** Three: **process-lifetime** (held by the session closure), **turn-lifetime** (allocated and abandoned per `ask`), and **the stack** (call frames, which behave specially under `await`).

**Axis: lifetime / reachability — "what keeps this object alive?"**

```
  One axis — "what keeps it reachable?" — traced down

  ┌──────────────────────────────────────────────┐
  │ session closure captures pool, agent → alive  │  → reachable for the whole run
  │ turns[] referenced by React state → alive      │
  └───────────────────────┬────────────────────────┘
       ┌──────────────────────────────────────────┐
       │ embedding[768], hits[], jsonb strings      │  → reachable only inside ask();
       └───────────────────────┬───────────────────┘     unreferenced after → GC
            ┌─────────────────────────────────────┐
            │ stack frame for ask()                 │  → unwinds at await, rebuilt
            └─────────────────────────────────────┘     on resume (NOT held while parked)
```

**The seam: the closure returned by `createChatSession()`.** Everything the closure captures (pool, agent, conversationId) is pinned to the heap for the session's life; everything allocated *inside* a single `ask()` and not captured is free to collect once the turn returns. That closure boundary is the line between "held forever" and "transient."

## How it works

### Move 1 — the mental model

You know how a React component's `useState` value survives every re-render — it's not re-created each time, it's *held* by the hook? A closure does the same for plain functions: variables it references don't die when the outer function returns, because the inner function still reaches them. `createChatSession` returns an object whose methods close over `pool`, so `pool` lives exactly as long as that object does.

```
  The pattern — a closure pins its captures to the heap

  createChatSession() {
    const pool = ...        ┐ captured by ask()/close() →
    return { ask, close }   ┘ pool stays reachable as long as the
  }                           returned object is referenced
  ── object dropped / close() ──► pool now unreachable ──► collectible
```

### Move 2 — the walkthrough

**The session closure is the long-lived root.** When `createChatSession` returns, the heap graph has a root from the chat component down to everything the session needs:

```ts
// src/session.ts:39-75 (abridged)
const pool = createPool(cfg.databaseUrl);     // ┐
const agent = new RagQueryAgent({ ... });     // ├ all captured by the returned closure
const conversationId = await startConversation(...);  // ┘
return {
  async ask(question) { /* uses pool, agent, conversationId, memory, trace */ },
  async close() { await pool.end(); },
};
```

`chat.tsx` holds this object in `session` for the life of the render tree (`src/cli/chat.tsx:62`), so none of it is collectible until the process exits or `close()` runs. This is deliberate — it's the "warm" in "warm pool." The cost is that the agent, the pipeline, and the memory engine sit in memory the whole time; for a single-user CLI that's a few MB, a non-issue. → `01` walks the pool lifetime; this is the memory view of the same decision.

**`turns[]` is the one structure that grows unbounded with conversation length.** Every exchange appends two entries:

```ts
// src/cli/chat.tsx:25, 29 — append per turn, never trimmed
setTurns((t) => [...t, { role: 'you', text: q }]);
setTurns((t) => [...t, { role: 'buffr', text: answer }]);
```

`turns[]` only grows. In a long session it holds every question and answer string in memory, and Ink re-renders the *entire* list each turn (`src/cli/chat.tsx:42-47`). For a personal CLI session this is fine — you'd close it long before it mattered. But it's the one structure whose memory is O(conversation length), and worth naming as the place that would need a window/cap if sessions ran for hours. That cap is *not yet exercised*.

**Per-turn allocations are transient and collectible.** Inside one `ask`, buffr allocates a 768-element embedding array (Ollama's response), serializes it to a text literal, gets back hit rows, and builds jsonb strings for the trace:

```ts
// src/pg-vector-store.ts:15-17 — a fresh string per vector, per query
function toVectorLiteral(v: number[]): string { return `[${v.join(',')}]`; }
// src/pg-vector-store.ts:80-84 — fresh hit objects, fresh meta objects per row
return rows.map((r) => ({ id: r.id, score: Number(r.score), meta: { ...(r.meta ?? {}), ... } }));
```

None of these are captured by the session closure. Once `ask` returns, nothing references the embedding array, the literal string, or the hit objects — they're unreachable and the next minor GC reclaims them. This is the healthy default: allocate freely inside a turn, let V8 sweep it. V8's generational GC is built for exactly this — short-lived "young generation" objects are cheap to collect.

**The stack does NOT stay on the stack across an await.** This is the runtime subtlety. When `ask` hits `await agent.answer(question)`, its stack frame *unwinds* — the thread returns to the event loop (→ `03`). The state needed to resume (`question`, the `answer` slot) is captured into a heap-allocated continuation, not parked on the C stack. So a turn waiting two seconds on Ollama is *not* holding a stack frame for two seconds; it's holding a small heap object. That's why thousands of parked awaits don't blow the stack — async suspension is a heap cost, not a stack cost.

```
  await unwinds the stack, parks state on the heap

  stack:  [ask frame] ──hits await──► [unwound, thread → loop]
  heap:                    [continuation: question, answer-slot] ← tiny
  resume: [ask frame rebuilt] ◄── continuation pulled off microtask queue
```

**No manual memory management anywhere — and that's correct here.** No `--max-old-space-size`, no `global.gc()`, no `Buffer` pooling, no `WeakMap` caches. buffr's allocations are small and short-lived; the default V8 heap and GC handle them. The only thing to watch is the two unbounded structures — `turns[]` and the trace `pending[]` (→ `07`) — and neither matters at single-user CLI scale. Manual GC tuning is *not yet exercised* and shouldn't be invented.

### Move 3 — the principle

In a GC'd runtime, memory bugs aren't "forgot to free" — they're "accidentally still reachable." Find your long-lived roots (here, the session closure), confirm what they pin (pool, agent, `turns[]`), and check whether any of those grow without bound. Everything else — the per-turn embeddings and hit rows — is transient by construction and the GC handles it. The stack, meanwhile, is shallow no matter how many awaits are parked, because async suspension lives on the heap.

## Primary diagram

```
  buffr — the heap graph and what's collectible

  ┌─ GC roots ────────────────────────────────────────────────────────────┐
  │  Ink render tree ──► session object ──► closure captures:              │
  │                                          pool, agent, conversationId,  │  PINNED
  │                                          memory engine, trace          │  (whole run)
  │  React state ──► turns[]  (grows every exchange — O(conv length))      │  PINNED+GROWS
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ during ask(): allocate, don't capture
  ┌─ Turn-scoped heap (collectible after ask returns) ────────────────────┐
  │  embedding[768] · "[0.1,...]" literal · hit rows · jsonb strings ·     │  TRANSIENT
  │  trace pending[] promises                                              │  → next GC
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ await
  ┌─ Stack (one thread) ──────────▼───────────────────────────────────────┐
  │  ask() frame unwinds at await; resume-state parked as heap continuation│  SHALLOW
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

V8's GC is generational: objects start in a small "young generation" (new space) collected frequently and cheaply with a copying collector; survivors get promoted to "old generation" collected less often with mark-sweep-compact. buffr's per-turn allocations — embeddings, hit rows, jsonb strings — are textbook young-generation: born inside a turn, dead by the end of it, swept in a fast minor GC. The session's captured objects (pool, agent) are promoted once and stay; that's the intended cost of a warm session. The classic leak in a long-lived Node process is an ever-growing collection held by a root — and buffr has exactly one candidate, `turns[]`, which is bounded in practice by how long a human keeps the CLI open. The async-suspension-is-heap-not-stack detail is what lets event-loop runtimes hold thousands of concurrent in-flight operations without the deep call stacks a thread-per-task model would need.

## Interview defense

**Q: A turn waits 2s on Ollama — is it holding a stack frame the whole time?**
No. At the `await`, `ask`'s stack frame unwinds and the thread returns to the event loop. The resume state is captured into a heap-allocated continuation, not parked on the stack. So waiting awaits cost a small heap object each, not a stack frame — which is why thousands of concurrent awaits don't overflow the stack.

```
  await ─► stack unwinds ─► continuation on heap (tiny) ─► resume later
```
Anchor: *async suspension is a heap cost, not a stack cost.*

**Q: Where's the one place memory grows without bound?**
`turns[]` in the chat UI — every exchange appends two entries and nothing trims it, so it's O(conversation length), and Ink re-renders the whole list each turn. At single-user CLI scale it's a non-issue; a hours-long session would want a windowed/capped history. That cap is *not yet exercised*. (`pending[]` in the trace sink is the other unbounded structure — see `07`.)

```
  turns[]: [you][buffr][you][buffr]... ← append-only, never trimmed
```
Anchor: *GC bugs are "still reachable," not "forgot to free" — find the growing root.*

## See also

- `01-runtime-map.md` — the pool whose lifetime the closure pins
- `04-shared-state-races-and-synchronization.md` — the same `turns[]` / `pending[]`, from the concurrency angle
- `07-backpressure-bounded-work-and-cancellation.md` — why unbounded `pending[]` is a backpressure gap

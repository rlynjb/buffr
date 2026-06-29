# Memory, Stack, Heap, GC, and Lifetimes — what lives, what grows, what gets collected

**Industry name(s):** stack vs heap, garbage collection (mark-and-sweep / generational), object lifetimes, closures, unbounded accumulation · *Industry standard*

---

## Zoom out, then zoom in

V8 manages memory for you — you never `free()`. So the question isn't "did I leak" in the C sense; it's **"what stays reachable, and does anything grow without bound?"** In this repo the answer is mostly "small and short-lived," with one structure that grows for the life of a chat session: the **`turns[]` history array**.

```
  Zoom out — where memory pressure could build

  ┌─ Interface layer ────────────────────────────────────────┐
  │  ★ turns[]: grows per turn, lives until /exit ★          │ ← the one to watch
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  pending[]: drained per turn  ·  session closure: fixed   │
  │  query buffers: rows[], hits[], the 768-float vectors     │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Storage / Provider ─────▼───────────────────────────────┐
  │  Postgres holds the durable corpus (not in JS heap)       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the **stack** holds call frames and primitives (fast, auto-freed on return); the **heap** holds objects, arrays, closures (GC-managed). A "lifetime" is how long something stays reachable from a root. The interesting lifetimes here are the closure that *is* the session, and the array that *is* the chat history.

---

## The structure pass

**Layers.** Short-lived (per-query buffers) → per-turn (the `pending[]` queue, the answer string) → session-lived (the `turns[]` array, the session closure) → durable (Postgres, outside the heap entirely).

**Axis — trace `lifecycle`: how long does this allocation stay reachable?**

```
  One axis, four altitudes: "when does this become collectable?"

  ┌─ per-query ─────────────────────┐  rows[], hits[], the 768-float arrays,
  │  unreachable after the function  │  vector literals → GC'd almost immediately
  └──────────────────────────────────┘
      ┌─ per-turn ──────────────────┐  pending[] (emptied implicitly each turn),
      │  unreachable after the turn  │  the answer string after render
      └──────────────────────────────┘
          ┌─ session-lived ─────────┐  turns[] (GROWS), session closure
          │  reachable until /exit   │  (pool, agent, conversationId — FIXED size)
          └──────────────────────────┘
              ┌─ process-lived ─────┐  module-level singletons, the React tree
              │  reachable until exit│
              └──────────────────────┘
```

The answer flips sharply at the session-lived tier: almost everything is collected within a turn, but `turns[]` keeps every exchange reachable until the process exits. That's the one lifetime worth a hard look.

**Seam — the closure boundary in `createChatSession`.** The load-bearing joint (`src/session.ts:34-76`). Variables declared in the function body (`pool`, `embedder`, `store`, `agent`, `conversationId`) are captured by the returned `ask`/`close` closures, so they outlive the function call — they're heap-promoted and stay alive as long as the session object is referenced. State-ownership flips across this seam: inside the function they're locals; once captured, they're long-lived session state. That capture is *why* the pool is warm across turns (`02`).

---

## How it works

### Move 1 — the mental model

You know how a React component's `useState` value survives between renders even though the function body re-runs? That's a closure holding the value on the heap. `createChatSession` does the same thing at the module level: it returns functions that *close over* the pool and agent, so they live as long as you hold the session. Memory in this repo is mostly: **a few long-lived closures, and a lot of short-lived per-turn garbage that V8 sweeps up.**

```
  Stack vs heap — the pattern shape

  STACK (per call, auto-freed)        HEAP (GC-managed, lives while reachable)
  ┌──────────────────────────┐        ┌────────────────────────────────────┐
  │ ask() frame              │        │  session closure ◄── captured by ask│
  │   q (string ref)         │ ─────► │    pool, agent, conversationId      │
  │   answer (string ref)    │        │  turns[] ◄── held by React tree      │
  │ returns → frame popped   │        │    {role,text}, {role,text}, ...     │
  └──────────────────────────┘        │  rows[]/hits[] ◄── GC'd after search │
   primitives live here;              └────────────────────────────────────┘
   object REFERENCES point to heap      roots: the React tree, module scope
```

The references live on the stack and die when the frame pops; the objects live on the heap and die when no reference points at them.

### Move 2 — the walkthrough

**The session closure — fixed-size, long-lived, intentional.** `createChatSession` allocates the pool, embedder, store, pipeline, tool registry, model provider, profile string, memory engine, conversation id, trace sink, and agent — all once (`src/session.ts:39-57`). The returned `ask`/`close` functions capture them:

```ts
// src/session.ts:59-75 — the closure that holds the session alive
return {
  async ask(question: string): Promise<string> {
    await persistMessage(pool, conversationId, 'user', question);  // captures pool, conversationId
    const answer = await agent.answer(question);                   // captures agent
    await trace.flush();                                           // captures trace
    try { await memory.remember({ conversationId, question, answer }); } catch {}
    return answer;
  },
  async close(): Promise<void> { await pool.end(); },              // captures pool
};
```

Everything those closures reference stays reachable for the session's life. This is a *fixed* footprint — it doesn't grow per turn. The `profile` string (loaded once at `src/session.ts:47`) is the only sizeable captured value, and it's bounded by the profile document. Good: building once and capturing is exactly why turns are cheap. The memory cost is paid once, up front.

**`turns[]` — the one structure that grows without bound.** Every turn appends two entries (the user line, the buffr line) and never removes any (`src/cli/chat.tsx:25,29`):

```ts
// src/cli/chat.tsx:11, 25, 29 — append-only, never trimmed
const [turns, setTurns] = useState<Turn[]>([]);
// ...
setTurns((t) => [...t, { role: 'you', text: q }]);      // grows
setTurns((t) => [...t, { role: 'buffr', text: answer }]); // grows
```

For a personal single-device agent this is fine — a human types maybe dozens of turns before quitting, each a few hundred bytes, and `/exit` frees the whole array. But it *is* an unbounded accumulation: a session left running for days, or one fed programmatically, would grow `turns[]` linearly forever. There's no cap, no windowing, no virtualization. Honest verdict: right call for the use case, and the first thing you'd change if the session ran unattended. (Note: this is *display* history only — it does **not** feed the model. The agent treats each question independently per `src/session.ts:24-27`; conversational recall rides retrieval, not `turns[]`.)

```
  turns[] growth — execution trace over a session

  turn 1:  turns = [you₁, buffr₁]                    len 2
  turn 2:  turns = [you₁, buffr₁, you₂, buffr₂]      len 4
  turn 3:  turns = [..., you₃, buffr₃]               len 6
   ...                                                ...
  turn N:  len = 2N   ── grows linearly, freed only at /exit (pool.end → exit)
                          no cap, no eviction
```

**Per-query garbage — collected almost immediately.** Each `search` builds a `rows[]` from Postgres, maps it to `hits[]` with reshaped `meta` (`src/pg-vector-store.ts:80-85`), and serializes vectors to text literals (`toVectorLiteral`, `src/pg-vector-store.ts:15-17`). A query embedding is a 768-element `number[]` — roughly 6KB as floats, plus its string literal form. All of it becomes unreachable when `search` returns, so V8's young-generation collector (the cheap, frequent "scavenge") reclaims it fast. This is the dominant allocation pattern in the hot path and it's exactly what generational GC is built for: lots of short-lived objects, swept cheaply.

**The stack — call depth is shallow.** The deepest synchronous chain here is a handful of frames (`onSubmit` → `ask` → `persistMessage`). No recursion in the repo's own code, so no stack-overflow risk. Async chains don't grow the stack — each `await` unwinds the current frame and schedules a continuation, so even a long turn never deepens the call stack. (Contrast your reincodes DSA work: `bfs_traversal` and the recursive BST `delete` *do* build real stack depth — that's the place stack lifetime matters; here it doesn't.)

### Move 2 variant — the load-bearing skeleton of "what stays alive"

The kernel of the repo's memory behavior — three reachability roots:

1. **The session closure** (root: the `session` const in `chat.tsx:62`). *Drop the reference* (e.g. `session = null` after `close`) and the pool, agent, and profile become collectable. This is the intended long-lived footprint.
2. **`turns[]`** (root: the React component's state, held by the render tree). *This is the only growing root.* What breaks if you forget it grows: a never-exiting session climbs in memory forever.
3. **Per-turn buffers** (no lasting root). *These have no root after their function returns* — which is exactly why they're collected promptly. The absence of a root is the feature.

Optional hardening, not present: a max-length cap on `turns[]`, or message virtualization. Not needed at human-session scale; named so you know where it would go.

### Move 3 — the principle

In a GC'd runtime, "memory management" reduces to **reachability**: an object lives exactly as long as a root can reach it, and dies when it can't. So you don't hunt for `free()` calls — you hunt for *roots that grow*. Here there's exactly one (`turns[]`), and it's bounded in practice by a human session. Everything else is either a fixed-size closure (paid once) or short-lived garbage (swept cheaply by the young generation). Find the growing roots and you've found every memory problem a managed runtime can have.

---

## Primary diagram

The full memory picture — roots, lifetimes, and the one growing structure.

```
  Memory & lifetimes — full recap

  ┌─ ROOTS (keep things reachable) ─────────────────────────────────┐
  │  module scope (chat.tsx)         React render tree               │
  │       │                               │                          │
  │       ▼ session const                 ▼ component state          │
  │  ┌──────────────────────┐        ┌──────────────────────────┐   │
  │  │ session closure      │        │ turns[]  ★ GROWS 2/turn ★ │   │
  │  │ pool·agent·profile   │        │ freed only at /exit       │   │
  │  │ FIXED size, paid once│        └──────────────────────────┘   │
  │  └──────────────────────┘                                       │
  └─────────────────────────────────────────────────────────────────┘
         per-turn / per-query (NO lasting root → collected promptly)
  ┌─────────────────────────────────────────────────────────────────┐
  │  pending[] (drained/turn)  rows[]  hits[]  768-float vectors     │
  │  → V8 young generation sweep (cheap, frequent)                   │
  └─────────────────────────────────────────────────────────────────┘
  Durable corpus lives in Postgres — NOT in the JS heap.
```

---

## Elaborate

V8's GC is generational: most objects die young, so it splits the heap into a young generation (scavenged often and cheaply) and an old generation (collected rarely with a fuller mark-sweep-compact). This repo's allocation profile — a few long-lived closures, a flood of short-lived per-query buffers — is the best case for that design: the per-query garbage never survives to the old generation. The one anti-pattern would be `turns[]` growing large enough to get promoted to the old generation and stay there; at human scale it never does.

The closure-as-long-lived-state pattern is the same one behind `useState`, behind a module-level singleton, behind any DI container that builds dependencies once. Worth recognizing it's the same mechanism: a function that returns functions capturing its locals is how you get "build once, use many" in a GC'd language without a class.

`not yet exercised`: no `--max-old-space-size` tuning, no manual `global.gc()`, no heap snapshots or `process.memoryUsage()` monitoring. None needed single-device. If buffr ran as a long-lived server, heap monitoring and a `turns[]` cap (or moving history out of memory) would be the first additions.

---

## Interview defense

**Q: "Where does this program accumulate memory, and what frees it?"**

> One structure grows: `turns[]`, the chat history, appends two entries per turn and is only freed when the user `/exit`s. Everything else is either a fixed-size closure built once in `createChatSession` — the pool, agent, profile, captured and held for the session — or short-lived per-query garbage (the row buffers, the 768-float vectors) that goes unreachable when the function returns and gets swept by V8's young generation. There's no manual freeing; it's all reachability. The honest gap: `turns[]` is unbounded, fine for a human session, wrong for an unattended one.

```
  the answer in one sketch — find the growing root

  fixed:   session closure (pool, agent, profile)  ── paid once
  growing: turns[] ── +2/turn, freed at /exit       ── the one to watch
  garbage: rows[], hits[], vectors ── GC'd per query ── young-gen sweep
```

**Anchor:** "The only growing root is `turns[]` at `src/cli/chat.tsx:11`; the session closure at `src/session.ts:39-57` is fixed and captured once — that's the warm-pool win."

---

## See also

- `01-runtime-map.md` — the resources the closure captures
- `02-processes-threads-and-tasks.md` — why the closure is built once per process
- `04-shared-state-races-and-synchronization.md` — the immutable updates that keep `turns[]` safe
- `07-backpressure-bounded-work-and-cancellation.md` — where a `turns[]` cap would live

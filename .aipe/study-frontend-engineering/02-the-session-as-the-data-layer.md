# 02 — The session as the data layer

**Industry name(s):** container/presentational split · data-layer
facade · the "one seam" boundary. **Type:** Industry standard (the
pattern); project-specific seam.

## Zoom out, then zoom in

You've drawn this boundary a hundred times: the component renders, a hook
or service fetches. The discipline is keeping the data machinery *out* of
the component so the view stays a pure function of state. Here the same
discipline is drawn at its sharpest — the view (`chat.tsx`) knows exactly
**one** thing about the entire backend: that `session.ask(string)` returns
a `Promise<string>`. Everything else — pg pool, embedder, vector store,
agent loop — lives behind that one method.

```
  Zoom out — the data seam in buffr-laptop

  ┌─ UI layer  src/cli/chat.tsx ────────────────────────────┐
  │  <Chat>  owns: turns / input / busy, the submit handler  │
  └───────────────────────────────┬──────────────────────────┘
                                  │  session.ask(q): Promise<string>
                                  │  ★ THE ONE SEAM ★          ← we are here
  ┌─ Data layer  src/session.ts ──▼──────────────────────────┐
  │  ChatSession { ask, close }                               │
  │  builds: pool · embedder · store · pipeline · tool ·      │
  │          model · profile · memory · agent · trace         │
  └───────────────────────────────┬──────────────────────────┘
                                  │  (agent loop · retrieval · Ollama · pg)
                                  ▼
                  study-system-design · study-networking
```

Zoom in: the pattern is **container/presentational split, drawn at a
module seam instead of a component seam.** The view is presentational
(plus the submit orchestration); `createChatSession()` is the container —
it constructs every dependency once and hands back a two-method object.
The question this answers: *how does the view stay ignorant of the entire
backend?*

## Structure pass

**Layers.** Two: the UI layer (`chat.tsx`) and the data layer
(`session.ts`). The data layer itself fans out into a build of nine
dependencies, but that fan-out is *below* the seam and the UI never sees
it.

**Axis — trace "what does this layer know about the backend?" across the
seam.** This is the axis that makes the seam load-bearing:

```
  one question across the seam

  "what does this side know about pg / Ollama / the agent?"

  ┌─ UI  chat.tsx ──┐   seam    ┌─ Data  session.ts ──────┐
  │  knows: NOTHING │ ═══╪════►  │  knows: EVERYTHING       │
  │  just ask()     │ (it flips) │  pool, model, agent, ... │
  └─────────────────┘            └──────────────────────────┘
         ▲                                ▲
         └──── same axis, two answers ─────┘
```

The answer flips hard across the seam: total ignorance on the UI side,
total knowledge on the data side. That flip is the contract — and it's
why you can read `chat.tsx` end to end without ever learning there's a
Postgres database involved.

**Seam.** The `ChatSession` type at `session.ts:29-32` *is* the contract:
two methods, `ask(question): Promise<string>` and `close(): Promise<void>`.
Everything the UI is allowed to do is in those two signatures. The seam is
load-bearing because *state ownership flips across it* too — the UI owns
ephemeral render state (`turns`/`input`/`busy`); the session owns the
durable conversation (the pg conversation row, the trace, the memory).

## How it works

#### Move 1 — the mental model

You know how you'd never put `new Pool()` and an embedding call directly
inside a React component — you'd hide it behind a hook or a service so the
component just calls `useData()` and renders? This is that, taken to the
limit. The component calls one async function and renders the result. The
"service" is an object built once at boot with all its dependencies
already wired, frozen into a closure.

```
  the facade pattern — a wide build behind a narrow door

   ┌─ narrow door (what the UI sees) ─┐
   │   ask(q) → Promise<string>        │
   │   close() → Promise<void>         │
   └─────────────┬────────────────────┘
                 │ behind the door:
   ┌─────────────▼────────────────────────────────────┐
   │  pool · embedder · store · pipeline · tool ·      │
   │  tools · model · profile · memory · conversation ·│
   │  trace · agent     (nine+ things, all hidden)     │
   └───────────────────────────────────────────────────┘
```

#### Move 2 — the walkthrough

**The container builds everything once, at boot.** Bridge from what you
know: this is the "construct your dependencies at the top of the tree"
move, except the top of the tree is `await createChatSession()` at
`chat.tsx:62`, called *before* `render()`. The function wires the pool,
embedder, store, pipeline, tool, model, profile, memory, conversation,
trace, and agent (`session.ts:39-57`) — eleven local bindings — and
returns an object exposing two of them as methods. Where it breaks if you
skip this: build inside the component instead, and every re-render would
risk reconstructing a pg pool. Building once, outside the component, is
the whole point.

**The returned object is a closure over those dependencies.** The `ask`
method at `session.ts:60-71` closes over `pool`, `conversationId`,
`agent`, `trace`, and `memory`. The UI holds a reference to this object
and calls `ask`; the dependencies ride along invisibly inside the closure.
This is why the UI needs zero imports from the data layer beyond the
*type* — it never names a single dependency.

```
  Layers-and-hops — one ask() crossing the seam

  ┌─ UI  chat.tsx:28 ─┐  hop 1: ask(q)         ┌─ Data  session.ts:60 ─┐
  │  await session    │ ──────────────────────► │  ask(question) {       │
  │     .ask(q)       │                          │   persistMessage(...)  │ hop 2
  └───────────────────┘                          │   agent.answer(q)      │ hop 3
        ▲                                        │   trace.flush()        │ hop 4
        │  hop 6: Promise<string> resolves       │   memory.remember(...) │ hop 5
        └─────────────────────────────────────── │   return answer        │
                                                 └────────────────────────┘
   hops 2-5 (persist, agent loop, flush, remember) are INVISIBLE to the UI —
   it only sees hop 1 (the call) and hop 6 (the resolved string).
```

**The UI's only knowledge is the type.** At `chat.tsx:5` the view imports
`type ChatSession` — a *type-only* import, erased at compile time. It
imports `createChatSession` to call once at boot, then never touches the
data layer again. Every interaction is through `session.ask` and
`session.close`. That's the container/presentational line: the view
presents, the session contains.

**Move 2 variant — the load-bearing skeleton.** The seam's kernel is three
parts:

1. **The narrow interface (`ChatSession`, two methods).** Drop it — widen
   the interface so the UI can reach `pool` or `agent` directly — and the
   ignorance collapses; the view now depends on pg and the agent loop, and
   you can't swap either without touching the view. The narrowness *is*
   the decoupling.
2. **The build-once boot (`createChatSession` at `chat.tsx:62`).** Drop it
   — build inside the component — and you reconstruct a pg pool per render.
3. **The closure (the returned object).** Drop it — make `ask` a free
   function taking eleven args — and the UI has to supply every dependency
   on every call, which means it has to *know* them.

Optional hardening: the best-effort memory write (`session.ts:64-69`,
swallowed so a memory failure can't lose the user's answer) and the
error-to-turn handling are robustness on top, not the skeleton.

#### Move 3 — the principle

A data layer earns its keep by *how little the view has to know*, not by
how much it does. The measure of this seam is the size of `ChatSession`:
two methods. The view could be ported to a web app, a Slack bot, or a REST
handler and the only contract it'd need is `ask(string): Promise<string>`.
That portability is what "loose coupling" actually buys you, made concrete.

## Primary diagram

The full seam, one frame: the narrow contract on the line, the wide build
below it, the UI's total ignorance above.

```
  The data seam — full picture

  ┌─ UI  src/cli/chat.tsx ──────────────────────────────────────┐
  │  import { createChatSession, type ChatSession }              │ line 5
  │  const session = await createChatSession()      ← boot once  │ line 62
  │  const answer = await session.ask(q)            ← the ONE    │ line 28
  │                                                   call       │
  └──────────────────────────────┬───────────────────────────────┘
       contract:  type ChatSession = { ask, close }  ← session.ts:29-32
  ┌──────────────────────────────▼───────────────────────────────┐
  │  src/session.ts — createChatSession() builds:                 │
  │   pool(39) embedder(40) store(41) pipeline(42) tool(43)       │
  │   tools(44) model(46) profile(47) memory(53) trace(56)        │
  │   agent(57)  →  returns { ask(60), close(72) }                │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for at exactly two moments: once at boot to
construct the session (`chat.tsx:62`), and once per user submit to run a
turn (`chat.tsx:28`). The `close` method is reached for on `/exit`
(`chat.tsx:19-20`) to drain the pool.

```
  src/session.ts  (lines 29-32) — the contract, the whole UI-visible API

  export type ChatSession = {
    ask(question: string): Promise<string>;   ← the one data call
    close(): Promise<void>;                    ← teardown (pool.end)
  };
       │
       └─ this two-line type is everything the view is allowed to know.
          Widen it and you leak pg/agent into the UI (load-bearing narrowness).
```

```
  src/session.ts  (lines 60-71) — ask() closes over the build

  async ask(question: string): Promise<string> {
    await persistMessage(pool, conversationId, 'user', question); ← durable: user turn
    const answer = await agent.answer(question);                  ← the agent loop runs
    await trace.flush();                                          ← durable: trajectory
    try {
      await memory.remember({ conversationId, question, answer });← best-effort recall
    } catch { /* swallow: memory is best-effort */ }              ← can't lose the answer
    return answer;                                                ← the ONLY thing the UI sees
  }
       │
       └─ pool, conversationId, agent, trace, memory are all CLOSED OVER —
          the UI passes none of them. That closure is why the UI stays ignorant.
```

```
  src/cli/chat.tsx  (lines 5, 28) — the UI side, total ignorance

  import { createChatSession, type ChatSession } from '../session.js'; ← line 5
       │  type-only import for ChatSession (erased); the value import
       │  createChatSession is called once and never referenced again.
  const answer = await session.ask(q);                                 ← line 28
       │  the entire backend, reduced to one awaited string. No pool,
       │  no model, no agent visible anywhere in this file.
```

## Elaborate

This is the Facade pattern (GoF) meeting container/presentational (React
lore), and the interesting twist is *where* the boundary lands: not
between two components, but between a component and a plain module. In a
browser app you'd often reach for a custom hook (`useChat()`) to hold this
seam; here it's a free async function returning a closure, because the
session is built once at process boot, not per-mount — there's no
component lifecycle to hang a hook on at boot time.

The *depth* of this module — a two-method interface hiding eleven
dependencies and an agent loop — is `study-software-design`'s lens
(Ousterhout's "deep module": small interface, large implementation). The
*architecture* of what's behind the seam — the warm pool, the single
long-lived conversation, the canonical-local store — is
`study-system-design`'s lens. This file owns only the seam as a *frontend
boundary*: the line the view doesn't cross.

What to read next: `04-async-ui-with-a-busy-flag.md` — the UI side of the
`await` at this seam, where the spinner covers the agent turn.

## Interview defense

**Q: "Walk me through how the UI talks to the backend."** Verdict first:
through exactly one method, `session.ask(q)`, and the UI knows nothing
else. I'd draw the seam:

```
   <Chat>  ──ask(q)──►  ChatSession  ──►  pool/agent/store/... (hidden)
   knows nothing        two methods       eleven dependencies
   but the type         the whole API     built once at boot
```

The load-bearing part people miss: the *narrowness* is the feature. Two
methods means the view depends on a `Promise<string>`, not on Postgres.
Anchor: the `ChatSession` type at `session.ts:29-32`.

**Q: "Why build the session outside the component instead of in a
hook/effect?"** Because it's built once at process boot
(`chat.tsx:62`), before `render()` — there's one pg pool and one
conversation for the whole process life. A hook would tie it to a
component mount and risk reconstructing the pool on re-render. The
tradeoff I accepted: the session isn't reactive (you can't swap it from
the UI), which is fine — there's exactly one.

**If you don't know:** "I know the UI's entire dependency on the backend
is the `ChatSession` type — I'd trace `ask` in `session.ts` to name what
runs inside, but from the view's side it's one awaited string."

## Validate

1. **Reconstruct:** draw the seam. How many methods does the UI see? Name
   them and their signatures (`session.ts:29-32`).
2. **Explain:** why is `import { type ChatSession }` at `chat.tsx:5`
   type-only, and what does that buy at the bundle/coupling level?
3. **Apply:** you want to add a "regenerate last answer" feature. Does it
   need a new method on `ChatSession`, or can it reuse `ask`? Defend it.
4. **Defend:** someone proposes moving `createChatSession`'s body into a
   `useEffect` inside `<Chat>`. What breaks? (Pool reconstruction per
   mount; loss of the single long-lived conversation.)

## See also

- `00-overview.md` — this is the #1 highest-leverage pattern.
- `04-async-ui-with-a-busy-flag.md` — the UI side of the `await` here.
- `study-software-design` — the deep-module depth of `ChatSession`.
- `study-system-design` — the architecture behind the seam.
- `study-networking` — the Ollama / pg wire below `ask`.

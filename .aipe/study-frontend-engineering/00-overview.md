# Frontend Engineering — Overview

One page. If you read only this, you know what the frontend layer of `buffr-laptop` is.

**The one-sentence rendering mode:** a single long-lived React component (`<Chat>`,
`src/cli/chat.tsx:9`) rendered to the *terminal* by Ink instead of to the DOM by
react-dom — same reconciler, same hooks, same controlled inputs, different host.

This is the one topic in the whole study set where you are the expert. Every primitive
here — `useState`, the controlled-input loop, the loading-state triad, `.map()` with a
`key` — is something you have shipped for seven years. The only new idea is that the
render target is stdout, not a document. Read the rest of this guide as "my React
knowledge, applied to a terminal."

## The state architecture, in one diagram

```
  All state lives in <Chat>, all transitions in onSubmit

  ┌─ <Chat session=… >  src/cli/chat.tsx:9 ─────────────────────┐
  │                                                             │
  │   useState turns: Turn[]   ← append-only transcript  :11    │
  │   useState input: string   ← controlled buffer       :12    │
  │   useState busy:  boolean  ← in-flight flag          :13    │
  │                                                             │
  │   onSubmit(value)  :15 ──────────────────────────────┐      │
  │     guard busy / /exit / empty        :17-24          │      │
  │     setInput('')                      :24             │      │
  │     setTurns(+you)  ; setBusy(true)   :25-26          │      │
  │     try   answer = await session.ask  :28  ──────────┼──┐   │
  │     then  setTurns(+buffr)            :29             │  │   │
  │     catch setTurns(+error)            :31             │  │   │
  │     finally setBusy(false)            :33             │  │   │
  │                                                       │  │   │
  │   render: header / turns.map / (Spinner | TextInput) │  │   │
  └──────────────────────────────────────────────────────┘  │   │
                                                             │   │
                          session.ask(q)  src/session.ts:60 ◄┘   │
                          persist → agent.answer → flush → remember
```

## The network seam, in one diagram

There is no HTTP client in the UI. The seam is a single awaited function call that fans
out to a database, a model server, and the aptkit agent loop — but from `<Chat>`'s view
it is exactly a `fetch()` with loading/success/error states.

```
  The async seam — one await, three sinks

  ┌─ UI ─────────────┐  await session.ask(q)   ┌─ Data layer ───────────┐
  │ <Chat> onSubmit  │ ──────────────────────► │ ChatSession.ask()      │
  │ chat.tsx:28      │                         │ session.ts:60          │
  │ busy=true ───────┤                         │  1 persistMessage (pg) │
  │ <Spinner/>       │                         │  2 agent.answer(q)     │
  │                  │  answer string          │     → Ollama + pgvector │
  │ busy=false ◄─────┤ ◄────────────────────── │  3 trace.flush (pg)    │
  │ setTurns(+buffr) │                         │  4 memory.remember     │
  └──────────────────┘                         └────────────────────────┘
```

## The three highest-leverage patterns (with files)

1. **react-without-the-dom** — the reconciler runs; Ink is the host renderer painting to
   a TTY. `src/cli/chat.tsx:2,63`. → `01-react-without-the-dom.md`
2. **async-ui-with-a-busy-flag** — `try/catch/finally` + `busy` + `<Spinner>`, the
   loading-state triad. `src/cli/chat.tsx:26-33,48-50`. → `03-async-ui-with-a-busy-flag.md`
3. **session-as-the-data-layer** — `<Chat>` owns display state; `session.ts` owns the
   canonical persisted state; the seam between them is one `ask()` call.
   `src/cli/chat.tsx:5,28` ↔ `src/session.ts:34,60`. → `04-session-as-the-data-layer.md`

## What is NOT here (named honestly)

Routing, CSS/styling beyond color props, DOM/browser APIs, SSR/hydration, bundlers,
HTTP client-fetch, web accessibility, design tokens, state stores. The terminal has no
analog for most of these, and the surface is one screen. See `audit.md` lenses 5–7 for
the `not yet exercised` entries.

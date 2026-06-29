# Frontend Engineering — Audit (Pass 1)

The frontend surface of `buffr-laptop` is one file: `src/cli/chat.tsx` (64 lines),
a React component rendered to the terminal by Ink. Its data layer is `src/session.ts`.
No browser, no DOM, no router, no CSS. This is React — the reconciler, hooks, controlled
inputs, async state — running against a TTY instead of a document.

This is your home turf wearing an unfamiliar coat. Everything you know about `useState`,
controlled components, and the loading-state triad transfers exactly. What changes is the
*host*: Ink swaps React's DOM renderer for one that paints box-drawing layout to stdout.
The audit below walks the standard 8 frontend lenses against that surface and says
`not yet exercised` honestly where a browser concept has no terminal analog.

```
  The whole frontend surface — one diagram

  ┌─ UI layer (terminal) ───────────────────────────────────────┐
  │  <Chat/>  src/cli/chat.tsx:9                                 │
  │    useState: turns / input / busy        (chat.tsx:11-13)    │
  │    <TextInput onSubmit={onSubmit}>       (chat.tsx:55)       │
  │    <Spinner/> while busy                 (chat.tsx:48-50)    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  session.ask(q)   (chat.tsx:28)
  ┌─ Data layer ──────────────────▼──────────────────────────────┐
  │  ChatSession  src/session.ts:34   ask() / close()            │
  │    persist → agent.answer() → trace.flush() → remember()     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  pg pool / Ollama / aptkit agent
  ┌─ Storage + model layer ───────▼──────────────────────────────┐
  │  Postgres + pgvector   ·   Ollama (gemma2 / nomic-embed)     │
  └──────────────────────────────────────────────────────────────┘
```

---

## 1. rendering-and-reactivity

**React, virtual-DOM reconciliation, rendering to a terminal — not a browser.** The
rendering mode is the closest thing the terminal has to an SPA: a single long-lived
process holding one component tree in memory, re-rendered on every state change. There
is no SSR, no hydration, no SSG, no RSC — those are all server-to-browser handoff
concepts and there is no browser here.

The reconciler is the standard React virtual-DOM diff (`react` ^18.3.1, `package.json:21`),
but the *renderer* is Ink (`ink` ^5.0.1, `package.json:18`) instead of `react-dom`. Ink
reconciles your `<Box>`/`<Text>` tree against a Yoga flexbox layout engine and paints the
result to stdout as box-drawing characters. When `setBusy(true)` fires (`chat.tsx:26`),
React schedules a re-render exactly as it would in a browser; Ink computes the new terminal
frame and writes the diff.

When work happens: mount (one `render(<Chat/>)` at `chat.tsx:63`), then update on every
`setTurns`/`setInput`/`setBusy` call. No commit-phase effects, no `useEffect`, no
concurrent features in play — this is sync React.

→ The event loop that actually drives the `await session.ask(q)` suspension belongs to
`study-runtime-systems`. → See **01-react-without-the-dom.md** for the deep walk on the
reconciler-and-host-renderer split.

## 2. state-architecture

**Three pieces of local component state, all owned by `<Chat>`. No store, no lifted
state, no derived state, no URL state.** The entire state graph:

- `turns: Turn[]` (`chat.tsx:11`) — the conversation transcript, append-only.
- `input: string` (`chat.tsx:12`) — the controlled text-input buffer.
- `busy: boolean` (`chat.tsx:13`) — the in-flight flag for the current `ask()`.

Every transition lives in one closure, `onSubmit` (`chat.tsx:15-35`). There is no Redux,
no Zustand, no Context, no `useReducer`. The component is small enough that flat `useState`
is the right call — lifting or globalizing this would be pure ceremony. **The one subtlety
worth naming:** `turns` is the *client* copy of conversation state, but the *canonical*
copy lives in Postgres (`messages`/`conversations`, written by `session.ask()` at
`session.ts:62-67`). `turns` is never re-read from the DB — it is a write-through display
buffer that happens to mirror what was persisted. The source-of-truth question has a real
answer and it is "the database," not "`useState`."

→ Server-state-vs-client-state ownership at the system level belongs to
`study-system-design`. → See **02-hooks-state-in-a-cli.md** for the `useState` triad walk
and **04-session-as-the-data-layer.md** for the client/canonical split.

## 3. component-architecture

**One component. No composition patterns yet — and that is the correct amount.** `<Chat>`
(`chat.tsx:9`) is the only component in the repo. It takes one prop (`session: ChatSession`,
`chat.tsx:9`) and renders three regions: a header (`chat.tsx:39-41`), the mapped transcript
(`chat.tsx:42-47`), and a state-switched footer that is either the spinner or the input
(`chat.tsx:48-57`).

There are no children/slots, no render props, no headless components, no compound APIs,
no container/presentational split. The `<Box>`/`<Text>` primitives from Ink are
composed declaratively — that *is* the JSX composition — but you author no abstractions
over them. For a 64-line UI this is right; the moment a second screen or a reusable
message-row appears, the `key`-mapped transcript (`chat.tsx:42`) is the first thing that
would graduate into a `<Message>` component.

→ Module depth and interface design belong to `study-software-design`.

## 4. data-fetching-and-cache

**One async call, the loading-state triad, no query library and no cache.** The fetch
seam is `session.ask(q)` (`chat.tsx:28`) — an awaited async call wrapped in
`try/catch/finally` (`chat.tsx:27-34`) with `busy` as the loading flag. This is the same
shape as a `fetch()` with loading/success/error states, except the "request" is a local
function call that fans out to a pg pool, an Ollama model, and the aptkit agent loop.

No react-query, no SWR, no route loaders, no optimistic updates, no cache invalidation,
no retry. Each `ask()` is fire-once-await-once. The closest thing to a cache is the
retrieval-based episodic memory inside `session.ts:53,65` — but that is server-side state
in pgvector, not a client fetch cache, and it belongs to system-design.

→ See **03-async-ui-with-a-busy-flag.md** for the try/finally + spinner walk. → Wire
semantics (the pg protocol, the Ollama HTTP calls) belong to `study-networking`; cache-as-
architecture belongs to `study-system-design`.

## 5. routing-and-navigation

`not yet exercised`. One screen, one process, no navigation. No route structure, no
code-splitting, no deep-linking — there is nowhere to route to. The `/exit` and `/quit`
string commands (`chat.tsx:18`) are the only "navigation" and they exit the app, not move
between views.

## 6. styling-and-design-system

**Color props only — no design system.** Styling is Ink's prop-based layout and color:
`flexDirection="column"` and `marginBottom` (`chat.tsx:38-43`) drive layout via Yoga;
`color="cyan"`/`"green"`/`"yellow"`, `bold`, and `dimColor` (`chat.tsx:44,49,52,54`) drive
appearance. There are no design tokens, no theme, no dark-mode switch, no responsive
breakpoints, no animation system beyond the `<Spinner type="dots">` (`chat.tsx:49`), which
is a prebuilt Ink component, not authored animation. CSS, CSS-in-JS, CSS Modules, and
utility-first frameworks are all `not yet exercised` — the terminal has no stylesheet.

## 7. browser-platform-and-build

**No Web APIs (no browser). The platform API is the TTY; the build is `tsc` to ESM.**
The platform surface Ink touches on your behalf is raw-mode stdin — Ink puts the terminal
into raw mode so `<TextInput>` (`chat.tsx:55`) can capture keystrokes character-by-character
instead of line-buffered. That is the terminal analog of a DOM `keydown` listener. No
Storage, Worker, ServiceWorker, IndexedDB, WebSocket, EventSource — none apply.

Build: `tsc -p tsconfig.json` (`package.json:7`) with `jsx: "react-jsx"` (`tsconfig.json:13`)
— the automatic JSX runtime, so no `import React` is needed (note `chat.tsx:1` imports only
`useState`). Output is ESM (`module: "NodeNext"`, `tsconfig.json:4`; `"type": "module"`,
`package.json:4`), run directly by Node from `dist/` (`npm run chat` → `node dist/src/cli/chat.js`,
`package.json:12`). There is no bundler — no Vite, Webpack, esbuild. No tree-shaking,
code-splitting, polyfills, or sourcemap config; Node consumes the emitted `.js` directly.

→ See **05-jsx-to-esm-build.md** for the `react-jsx` + ESM toolchain walk. → Bundle-size
*measurement* would belong to `study-performance-engineering`, but there is no bundle.

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. This is a small, clean surface — the flags are minor
and mostly inference, labeled as such.

1. **`turns` and the database can silently diverge** (`chat.tsx:25,29` vs `session.ts:62-67`).
   The client appends to `turns` on submit and on answer, while `session.ask()` independently
   persists. If `persistMessage` succeeds but `agent.answer()` throws, the DB has the user
   turn but the screen shows an `error:` bubble (`chat.tsx:31`) — the two stores disagree and
   nothing reconciles them. *Consequence:* a replayed conversation from the DB would not match
   what the user saw. Real, but low-stakes single-device.

2. **`key={i}` uses the array index** (`chat.tsx:43`). Because `turns` is strictly append-only
   and never reordered or spliced, index keys are *safe here* — but this is the exact pattern
   that bites the moment anyone inserts, filters, or removes a turn. Flagged because you know
   this one cold and a reviewer will look for it.

3. **No cancellation on an in-flight `ask()`** (`chat.tsx:28`). `busy` blocks a *second*
   submit (`chat.tsx:17`), but there is no way to abort the current one — no AbortController,
   no escape-to-cancel. A slow Ollama generation locks the UI in `thinking…` with no exit but
   killing the process. *Consequence:* perceived hang on a slow model. Cancellation semantics
   belong to `study-runtime-systems`; the UI-side gap is the missing abort affordance.

4. **`render()` and `await createChatSession()` at module top level** (`chat.tsx:62-63`).
   A `createChatSession()` rejection (e.g. `DATABASE_URL` unset, `session.ts:37`) throws before
   `<Chat>` ever mounts — an unhandled top-level rejection with a raw stack trace, not a rendered
   error state. *Consequence:* startup failures look like a crash, not a message. Minor; it is a
   dev-run CLI.

No re-render-per-keystroke pathology worth flagging: `<TextInput>` re-rendering on each
`onChange` (`chat.tsx:55`) is correct controlled-input behavior, and the tree is tiny, so
Ink repaints are cheap.

# audit.md — the 8-lens frontend sweep

Pass 1. Every lens, walked against the real code, with `file:line`
grounding or an honest `not yet exercised`. The frontend surface is two
files: `src/cli/chat.tsx` (the view) and `src/session.ts` (its data
layer). Five of the eight lenses come back exercised in a stripped-down
form — the browser is gone, so half the inventory is genuinely N/A.

The honest headline first: **this is React with the DOM swapped for a
terminal.** Everything about rendering, state, components, input, and
async data flow is real React. Everything about routing, CSS, HTTP-fetch,
the browser platform, and the bundler is `not yet exercised` — not because
the repo skipped them, but because a terminal app doesn't have them.

```
  the 8 lenses, at a glance

  1. rendering-and-reactivity   ████████  exercised  → 01
  2. state-architecture         ████████  exercised  → 03
  3. component-architecture     ████████  exercised  → 02
  4. data-fetching-and-cache    ██████░░  exercised  → 02, 04
  5. routing-and-navigation     ░░░░░░░░  not yet exercised
  6. styling-and-design-system  ██░░░░░░  color props only
  7. browser-platform-and-build ███░░░░░  no browser; tsc build; raw TTY → 05
  8. frontend-red-flags-audit   ████░░░░  three real flags, all minor
```

---

## 1. rendering-and-reactivity

**Exercised — through Ink, not the browser.** The rendering mode is a
client-side React tree whose host is the terminal. `render(<Chat .../>)`
at `chat.tsx:63` hands the root component to Ink's reconciler, which
diffs the React element tree and paints the result as text to stdout
instead of mutating a DOM.

- **Rendering mode:** client-side, single component tree. No SSR, no SSG,
  no hydration, no RSC. There is no server handing markup to a client;
  the process *is* the client, and the "screen" is the terminal frame.
- **Reconciliation model:** virtual-tree diffing, same as React-DOM —
  Ink is a custom reconciler (`react-reconciler`) whose host instances
  are layout boxes, not DOM nodes. State change → re-render of `<Chat>`
  → Ink diffs → repaints the changed region of the terminal.
- **Scheduling:** synchronous, React 18 (`react: ^18.3.1`,
  `package.json:21`). No `Suspense`, no `useTransition`, no concurrent
  features in play. Every `setState` schedules a synchronous re-render.
- **When work happens:** on mount (`render` at `chat.tsx:63`) and on
  every `useState` setter call — `setInput` per keystroke
  (`chat.tsx:55`), `setTurns` / `setBusy` per submit (`chat.tsx:25,26,29`).

The reconciler is the most load-bearing rendering fact and gets the deep
walk. → see `01-react-without-the-dom.md`.

The runtime mechanism *underneath* this — the Node event loop that the
reconciler and the raw-mode stdin read loop both sit on — is
`study-runtime-systems`'s lens, not this one.

## 2. state-architecture

**Exercised — `useState`, in its purest form.** Three pieces of local
component state, all living in `<Chat>` at `chat.tsx:11-13`. No store, no
context, no reducer, no URL state, no form library, no derived-state
selector. This is the smallest honest state graph a real app can have.

```
  the entire state graph — chat.tsx:11-13

  turns:  Turn[]    transcript, append-only      chat.tsx:11
  input:  string    in-progress text field       chat.tsx:12
  busy:   boolean   is a turn in flight?          chat.tsx:13
```

- **Local component state:** all three. Nothing is lifted because there's
  exactly one component that owns state.
- **Server state:** lives behind `session.ask()` and never enters React
  state as a cache — the answer string is appended to `turns` and that's
  it. There's no query cache, no `staleTime`, no invalidation, because
  there's nothing to re-fetch. → lens 4.
- **Derived state:** none. `busy` could arguably be derived from "is
  there a pending promise," but it's stored explicitly as a flag — which
  is the right call here (a boolean is cheaper to reason about than
  promise-tracking). → see `04-async-ui-with-a-busy-flag.md`.
- **Form state:** `input` is a single controlled string. No multi-field
  form, no validation, no dirty-tracking. → see `05-controlled-text-input.md`.
- **URL state:** `not yet exercised` — no URL, no router, no deep-link.

The `useState` triad and its one-transition-touches-all-three submit
handler get the deep walk. → see `03-hooks-state-in-a-cli.md`.

System-level state ownership — that the *canonical* conversation lives in
Postgres via `session.ts`, not in React — is `study-system-design`'s
lens. This lens owns only the in-component state graph.

## 3. component-architecture

**Exercised — one component, clean container/presentational split.**
There is exactly one app component, `Chat` (`chat.tsx:9-60`), composed
from Ink's primitive components (`Box`, `Text`) and two third-party leaf
components (`TextInput`, `Spinner`).

- **Composition:** flat. `<Chat>` renders a `<Box flexDirection="column">`
  containing a header, a `turns.map()` list (`chat.tsx:42-47`), and a
  conditional input-or-spinner (`chat.tsx:48-57`). No children-as-props,
  no render props, no compound components, no headless pattern — the tree
  is too small to earn any of them.
- **Boundary placement:** the one boundary that matters is *not* between
  components — it's between `<Chat>` and `session.ts`. `<Chat>` is
  presentational-plus-orchestration (it owns the submit handler); all the
  data-layer machinery (pool, embedder, store, model, agent) lives behind
  `createChatSession()`. That's container-vs-presentational discipline
  drawn at the *module* seam instead of a component seam. → see
  `02-the-session-as-the-data-layer.md`.
- **Abstraction earning its place:** `TextInput` and `Spinner` are the
  only abstractions pulled in, and both earn it — a raw-mode controlled
  input and an animated spinner are real work you don't want to hand-roll.

Module *depth* — that `ChatSession` is a two-method interface
(`ask`/`close`) hiding a seven-dependency build — is `study-software-design`'s
lens. This lens names the seam; software-design measures its depth.

## 4. data-fetching-and-cache

**Exercised — but there's no HTTP and no cache in the UI.** Server state
crosses into the UI through exactly one async call: `await session.ask(q)`
at `chat.tsx:28`. That's the whole network seam, from the view's point of
view.

- **Fetch wrapper:** `session.ask()` *is* the wrapper, and it's a deep
  one — behind that single `Promise<string>` sits a pg pool, an Ollama
  embedder, a vector store, a retrieval pipeline, a tool registry, a
  guarded model, an agent loop, and a trace sink (`session.ts:34-76`).
  The view knows none of it.
- **Query library:** `not yet exercised` — no react-query, no SWR. There
  is nothing to cache: every `ask` is a fresh agent turn, and the
  transcript is the only "cache," held in `turns`.
- **Mutations / optimistic updates:** the submit *is* effectively a
  mutation, and there's a deliberate optimistic-ish move at
  `chat.tsx:25` — the user's turn is appended to `turns` *before* the
  await resolves, so the question echoes instantly while the answer is in
  flight. There's no rollback because appending the user's own text can't
  fail.
- **Error and retry behavior:** error is caught at `chat.tsx:30-32` and
  rendered as a `buffr` turn (`error: <message>`) rather than crashing the
  app. No retry — a failed turn is final, and the input comes back for the
  user to try again. That's the right call for an interactive REPL; an
  auto-retry would double-spend an LLM call silently.
- **Loading state:** the `busy` flag (`chat.tsx:13`) gates a spinner
  during the await. → see `04-async-ui-with-a-busy-flag.md`.

The wire itself — Ollama HTTP, the pg protocol — is `study-networking`'s
lens. This lens owns only where the async seam sits in the UI.

## 5. routing-and-navigation

**`not yet exercised`.** There is no router, no routes, no navigation, no
code-splitting at a route boundary, no guards, no loaders, no scroll
restoration, no deep-linking. The app is a single screen that grows a
transcript downward. The closest thing to "navigation" is the `/exit`
and `/quit` commands at `chat.tsx:18` — but that's a command, not a route
transition; it tears down the session and exits the process.

A terminal REPL has no navigation surface. This lens is genuinely N/A,
not skipped.

## 6. styling-and-design-system

**Barely exercised — color props, no CSS, no design system.** Ink has no
stylesheets. Styling is done through component props:

- `dimColor` on the header (`chat.tsx:40`) and `bold color={...}` on the
  role label (`chat.tsx:44`), where the color is `cyan` for `you` and
  `green` for `buffr`.
- `color="yellow"` on the spinner (`chat.tsx:49`), `color="cyan"` on the
  prompt arrow (`chat.tsx:54`).
- Layout via `flexDirection="column"` and `marginBottom={1}`
  (`chat.tsx:38,39,43`) — Ink reimplements a flexbox subset (Yoga) for
  terminal layout, so the *layout* model is familiar even though there's
  no CSS.

What's absent and genuinely N/A: design tokens, theming, dark-mode
toggle, responsive breakpoints, container queries, fluid type, an
animation system, CSS-in-JS, CSS Modules, utility classes. There is no
design system because there are three colors and one margin value, all
inline. That's correct for the surface size — a token layer over three
colors would be ceremony.

Color choice as a semantic signal (`you` = cyan, `buffr` = green) is the
one design decision worth naming, and it's a one-liner, not a pattern.

## 7. browser-platform-and-build

**Partly exercised — no browser, a `tsc` build, and one real platform
API: the raw-mode TTY.**

- **Web APIs:** `not yet exercised` — no `localStorage`, no `Worker`, no
  `ServiceWorker`, no `IndexedDB`, no `WebSocket`, no `EventSource`, no
  `fetch` from the client. None of these exist in a Node terminal process.
- **The platform API that *is* touched:** the raw-mode TTY. `TextInput`
  (`ink-text-input`, `package.json:20`) reads `process.stdin` one
  keypress at a time in raw mode — the terminal equivalent of a
  `keydown` listener on an `<input>`. This is the real input/platform
  seam, and it's where the controlled-input pattern lives. → see
  `05-controlled-text-input.md`.
- **Build:** `tsc -p tsconfig.json` (`package.json:7`). No Vite, no
  Webpack, no esbuild, no bundler at all. TypeScript compiles
  `src/**/*.tsx` to `dist/`, and `node dist/src/cli/chat.js`
  (`package.json:12`) runs it. JSX is compiled via `jsx: react-jsx`
  (`tsconfig.json:13`) — the automatic runtime, so there's no
  `import React` needed (and indeed `chat.tsx:1` imports only
  `useState`). Module system is ESM / NodeNext (`tsconfig.json:4-5`,
  `"type": "module"` in `package.json:3`).
- **Deploy artifact:** a directory of `.js` files run by Node. No bundle,
  no tree-shaking, no minification, no sourcemaps configured, no
  polyfills (none needed — the target is one Node version, `ES2022` at
  `tsconfig.json:3`).

Bundle-size *measurement* (if there were a bundle) would be
`study-performance-engineering`'s lens. There's no bundle to measure
here.

## 8. frontend-red-flags-audit

Three real flags, all minor — this is a small, honest surface. Ranked by
user-visible consequence.

```
  red flags, ranked by what the user feels

  1. ░░  full-frame repaint per keystroke   perf, invisible at this size
  2. ░░  index-as-key on the transcript     correct here, fragile if it grows
  3. ░░  no input disabled-state on error   cosmetic
```

**1. Full-frame repaint per keystroke (perf, currently invisible).**
Every keystroke fires `setInput` (`chat.tsx:55`), which re-renders
`<Chat>` and re-runs `turns.map()` (`chat.tsx:42-47`) over the entire
transcript. Under React's default behavior this *would* re-render and
re-diff the whole list on every character typed — there's no
`memo`, no virtualization. At a handful of turns this is free; Ink's diff
only repaints what changed. The flag is real but the consequence is zero
at this scale — naming it is the point, not fixing it. The *measurement*
of repaint cost is `study-performance-engineering`'s lens.

**2. Index-as-key on the transcript (correctness, latent).** The list
key is the array index, `key={i}` at `chat.tsx:43`. This is safe *only*
because `turns` is strictly append-only — no insert, no reorder, no
delete. The moment the transcript grows an edit/delete/reorder feature,
index keys will mismatch React's reconciliation and mis-associate turns.
Today it's correct; it's a flag because the safety is conditional on an
invariant that isn't enforced anywhere.

**3. No explicit disabled-state on error recovery (cosmetic).** The
`busy` guard at `chat.tsx:17` prevents double-submit while a turn is in
flight, which is the important guard. On error, `busy` resets to `false`
in the `finally` (`chat.tsx:32-34`) and the input returns — correct. The
only nit: there's no visual distinction between "ready after success" and
"ready after error," so a user who fired a failing query sees the error
turn and a fresh prompt with no explicit "that failed, try again" cue
beyond the `error:` text itself. Cosmetic, not a bug.

What's notably *absent* from the flag list, and good: state stored where
it can't be invalidated (no — server state isn't cached in React at all),
route boundaries that block first paint (no routes), theme tokens that
don't compose (no themes), platform features used without a fallback (the
raw-mode TTY is the only platform feature, and Ink degrades if stdin
isn't a TTY).

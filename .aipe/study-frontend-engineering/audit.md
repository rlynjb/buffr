# Frontend audit — Pass 1, the 8 lenses

The frontend surface is one component, `<Chat>` (`src/cli/chat.tsx`), rendered by **OpenTUI** (`@opentui/react`) to a terminal via a Zig native core (`bun:ffi`), sitting on a data façade (`createChatSession`, `src/session.ts`). Runs under **Bun** (not Node). This audit walks the eight frontend lenses against that surface. Where a lens finds nothing, it says `not yet exercised` — no invented patterns.

Calibration note for you: this is a terminal React UI. Treat every browser instinct as a hypothesis to check, not a given. Most of your hooks knowledge holds verbatim; the platform and paint layers are where it bends.

---

## 1. rendering-and-reactivity

**Rendering mode:** client-rendered, single-screen, **SPA-equivalent with no router**. There is no SSR, no SSG, no hydration, no React Server Components. The app boots, renders one component tree, and reconciles in place for the life of the process.

**Reconciliation model:** virtual-DOM diffing — the standard React reconciler — but the **host renderer is OpenTUI (`@opentui/react`), not react-dom** (`createRoot(renderer).render(<Chat …/>)`, `src/cli/chat.tsx`). React builds and diffs the element tree exactly as it does in a browser; OpenTUI's renderer commits the diff to **terminal cells** via a Zig native core (loaded over `bun:ffi`). Your `<box flexDirection="column">` is flex-laid-out text printed to stdout — not a real `<div>`. React 19.2.8. Runs under **Bun** (OpenTUI requires `bun:ffi`).

**Scheduling:** React 19.2.8 (`react@^19.2.8`, `package.json`). No `startTransition`, no Suspense, no concurrent features in use. Every `setState` schedules a reconcile that repaints the terminal frame.

**When work happens:** on mount and on every state update — four update sources: `setTurns`, `setBusy`, `setStatus`, `setLiveTokens`. The transcript re-renders on `turns` and `busy` changes; `<Spinner>` re-renders every 100ms during a turn via its own `setInterval`. The `<textarea>` is **uncontrolled** — no `value`/`onChange` per keystroke. → full walk in `01-react-without-the-dom.md`. The event-loop mechanics of how the awaited turn yields belong to `study-runtime-systems`.

---

## 2. state-architecture

The client state graph is **four `useState` hooks plus two `useRef`s** — `taRef` in `<Chat>`, `startRef` in `<Spinner>`:

| state | type | role | who transitions it |
|-------|------|------|--------------------|
| `turns` | `Turn[]` | the transcript, append-only | `setTurns(t => [...t, …])` on submit and on answer/error |
| `busy` | `boolean` | loading flag, one turn in flight | `setBusy(true)` before the async hop, `setBusy(false)` in both `.then` and `.catch` |
| `status` | `string` | live spinner label ("searching Google…", "analyzing…", "running eval…") | `onStatus` callback from `session.ask()` or `session.analyze()` opts; `setStatus` called directly for `/eval` |
| `liveTokens` | `{input,output}` | live token counter, accumulated during turn | `onTokens` callback from `model_usage` events |
| `taRef` | `useRef<any>` | ref to the `<textarea>` node | used to read `.plainText`, call `.setText('')`, call `.newLine()` |
| `startRef` | `useRef<any>` (inside `<Spinner>`) | spinner start-time (NOT useState — avoids render on capture) | reset in `Spinner`'s `useEffect` on mount |

Input text is **not in React state** — OpenTUI's `<textarea ref={taRef}>` is uncontrolled: it holds its own internal text buffer, `taRef.current.plainText` reads it, `setText('')` clears it, `newLine()` inserts a newline. The previous `<input onSubmit>` (controlled/uncontrolled) has been replaced by a multiline `<textarea>`. → `05-uncontrolled-input-with-submit.md`.

**Local only.** No global store (Redux/Zustand), no Context, no lifted state, no URL/route state, no form library. Source-of-truth for the *conversation itself* lives **below the UI** — the persisted `conversations`/`messages` rows and the in-process `ChatSession` (`src/session.ts`). The component's `turns` is a **display projection**, not the canonical record; the canonical record is the DB. → `02-hooks-state-in-a-cli.md`. System-level state ownership (warm pool, one conversation across turns) is owned by `study-system-design`.

---

## 3. component-architecture

**One component plus one helper, no composition tree to speak of.** `<Chat>` is the main application component; `<Spinner>` is a custom leaf that owns its own `setInterval` animation and `useRef` start-time. The rest are OpenTUI primitives: `<box>`, `<scrollbox>`, `<text>`, `<textarea>`. No children/slots/render-props/compound/headless patterns — there's nothing to compose yet.

**New OpenTUI primitives since last audit:**
- `<scrollbox flexGrow={1} scrollY stickyScroll stickyStart="bottom">` — scrollable transcript container that auto-scrolls to the latest turn. Replaced the plain `<box>` that re-rendered the whole list.
- `<textarea ref={taRef}>` — multiline text input. Replaced `<input onSubmit>`. The ref API (`plainText`, `setText`, `newLine`) is the uncontrolled interface.
- `useKeyboard(handler)` hook — intercepts raw keyboard events before OpenTUI's default handling. Used to distinguish Enter (submit) from Alt+Enter (new line) — `e.meta` is truthy for Alt/Option key.

**The boundary that *does* exist is vertical:** `<Chat>` (presentational: renders, owns ephemeral UI state) vs `createChatSession` (container: owns data acquisition). `<Chat>` receives `session` and `onExit` as props — dependency injection — and never imports pg, the agent, or the embedder. → `04-session-as-the-data-layer.md`.

`<Spinner>` takes two live props: `status` (string label) and `tokens` ({input, output}). It owns its own `useRef(Date.now())` start-time and `setInterval(100ms)` elapsed counter. This is a lean real-time component: no props drilling of the whole session, just the two live signals it needs.

---

## 4. data-fetching-and-cache

**One fetch path, no cache layer — live callbacks for progress.** Server state crosses into the UI through a single async hop: `session.ask(q, { onStatus, onTokens, onComplete }).then(…).catch(…)`. No react-query, no SWR, no route loaders, no optimistic updates, no cache invalidation, no retry/backoff in the UI. The three callbacks are the side-channel for live progress: `onStatus` → `setStatus` (spinner label), `onTokens` → `setLiveTokens` (accumulated), `onComplete` → captures `TurnStats` (durationMs, inputTokens, outputTokens) for the per-turn footer displayed after `setBusy(false)`.

The **loading/success/error state machine** is hand-rolled: `setBusy(true)` → `.then` success appends a `buffr` turn / `.catch` appends an error turn / both clear `busy`. The re-entrancy guard `if (busy || !q) return` inside `handleSubmit` is the manual stand-in for what a query library's `isFetching` would gate. → `03-async-ui-with-a-busy-flag.md`.

Optimistic update — *partial*: the user's own turn is appended **before** the async hop resolves, so the question shows instantly. The answer is not optimistic; it waits.

---

## 5. routing-and-navigation

`not yet exercised`. One screen, one component, no routes, no navigation, no history, no deep-linking, no code-splitting at a route boundary. The "navigation" events are slash commands handled inside `handleSubmit` before the `session.ask()` path:

- `/exit`/`/quit` → calls `onExit()` → `session.close()` → `process.exit(0)`. Process teardown.
- `/investing <TICKER>` (`chat.tsx:65-83`) — parses ticker, calls `detectEntityType()`, sets `setBusy(true)` + `setStatus('analyzing…')`, calls `session.analyze(ticker, entityType, opts)` via `.then/.catch`. Same async promise-chain pattern as the main `ask()` path — no new render primitives needed.
- `/eval` (`chat.tsx:84-94`) — sets `setBusy(true)` + `setStatus('running eval…')`, calls `session.evalInvesting()` via `.then/.catch`. Simpler than `/investing` — no `onStatus`/`onTokens` callbacks because `evalInvesting()` is synchronous-equivalent (pure Scorer math, no model calls mid-flight).

**The pattern for slash commands:** all slash commands are intercepted in `handleSubmit` before the `session.ask()` call, each returning early. No changes to the render path are needed for new commands — they compose through the same `setTurns(t => [...t, { role: 'buffr', text: answer }])` / `setBusy(false)` idiom.

**What's new in the state machine for `/investing`:** the `onStatus` callback is wired (Analyzer fires status events during its tool-calling loop), so the spinner label updates live during analysis. The `/eval` command does not wire `onStatus` because `evalInvesting()` runs Scorer locally (no model events).

**Still zero tests on these handlers.** The `/investing` command path has its own error branch (`catch` → renders `error: <message>` as buffr turn) and its own `capturedStats` capture — both untested. → see `study-testing/audit.md`.

---

## 6. styling-and-design-system

`not yet exercised` as a *system*. Styling is **OpenTUI prop-level color and border only**. Current palette:

- Header text: `fg="#888888"` (muted grey)
- "you" label: `fg="#00CCFF"` bold, body: `fg="#66BBCC"` (cyan tone)
- "buffr" label: `fg="#00EE66"` bold, body: `fg="#E8E8E8"` (near-white)
- Stats footer per buffr turn: `fg="#555555"` (dimmed)
- Spinner: `fg="#FFFF00"` (yellow)
- Input border: `borderColor="#444444"`, `borderStyle="rounded"`, `border={true}`
- Scrollbar: `color: '#333333'`

Layout uses `<box flexDirection="column" height="100%" paddingLeft={2} paddingRight={2}>` as the root container. `<scrollbox>` for the transcript. Input sits in a rounded-border `<box>` with `marginTop={1} marginBottom={1}`. No CSS, no CSS-in-JS, no design tokens, no theming, no responsive breakpoints. There is nothing to "scale as components grow" because there is one component and a fixed palette. → `study-performance-engineering` for render measurement.

---

## 7. browser-platform-and-build

**Platform APIs:** the platform is the **TTY, not the browser**. No Storage / Worker / ServiceWorker / IndexedDB / WebSocket / EventSource. The platform primitives in play:
- **`useKeyboard`** (OpenTUI hook) — intercepts raw key events before OpenTUI's input handling. The Enter/Alt+Enter split is implemented here: `e.name === 'return'` + `e.meta` → `newLine()`, else → `handleSubmit()`.
- **`<textarea ref={taRef}>`** — OpenTUI's multiline text input. The ref API (`plainText`, `setText`, `newLine`) is the uncontrolled surface.
- **`<scrollbox>`** — OpenTUI's scrollable container; `stickyScroll` + `stickyStart="bottom"` keeps the view pinned to the latest turn.
- **bun:ffi** — OpenTUI loads its Zig core via Bun's foreign-function interface. This is why `npm run chat` invokes Bun, not Node.

**Build:** Now a **monorepo** (`workspaces: ["packages/*"]`). Build script: `npm run build:packages` (builds `@buffr/contracts`, `@buffr/kernel`, `@buffr/connectors`) then `tsc -p tsconfig.json` for root TypeScript. The chat artifact (`dist/src/cli/chat.js`) is launched by Bun. All other scripts run via Node. JSX compiles via `/** @jsxImportSource @opentui/react */` pragma. No bundler, no tree-shaking, no polyfills. → `05-uncontrolled-input-with-submit.md`.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence.

**1. `<scrollbox>` re-renders the whole transcript on every turn (improvement: now auto-scrolls).** `<scrollbox stickyScroll stickyStart="bottom">` keeps the latest turn visible automatically — the previous plain `<box>` had no scrolling at all. Remaining concern: the list still grows unbounded; at hundreds of turns each reconcile re-evaluates every turn in the list. The move if it surfaces: `React.memo` per-turn component. Inferred structurally, not measured — measurement belongs to `study-performance-engineering`.

**2. `turns` (display state) can drift from the DB (canonical state).** The transcript is rebuilt fresh each process start from `useState<Turn[]>([])` — it never reads back the persisted `messages`. Consequence: the on-screen history is session-local; a crash mid-turn loses the displayed transcript even though the user turn was persisted. Deliberate split (display projection vs source of truth), not a bug. Owned at the system level by `study-system-design`.

**3. No async-hop cancellation.** `session.ask(q)` can't be cancelled once started — there's no `AbortController`, and `/exit` via `handleSubmit` can't interrupt an in-flight turn (the `busy` guard blocks new input but the pending async hop runs to completion). Acceptable for a single-user local CLI. Cancellation mechanics belong to `study-runtime-systems`.

**4. Error surface is a string in the transcript.** The `.catch` stringifies `(err as Error).message` into a buffr turn. No error type discrimination, no retry affordance. Fine for a personal tool.

**5. `taRef` is typed `any`.** Both `taRef` and the `startRef` inside `<Spinner>` are typed `useRef<any>` with `eslint-disable-next-line` suppression. OpenTUI doesn't export a typed element ref interface, so this is a platform limitation, not a design smell — but it means the `.plainText`/`.setText`/`.newLine()` calls are unchecked at compile time. The risk: a future OpenTUI version that renames these methods fails at runtime with no TS error.

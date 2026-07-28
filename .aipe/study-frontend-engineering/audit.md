# Frontend audit — Pass 1, the 8 lenses

The frontend surface is one component, `<Chat>` (`src/cli/chat.tsx`), rendered by **OpenTUI** (`@opentui/react`) to a terminal via a Zig native core (`bun:ffi`), sitting on a data façade (`createChatSession`, `src/session.ts`). Runs under **Bun** (not Node). This audit walks the eight frontend lenses against that surface. Where a lens finds nothing, it says `not yet exercised` — no invented patterns.

Calibration note for you: this is a terminal React UI. Treat every browser instinct as a hypothesis to check, not a given. Most of your hooks knowledge holds verbatim; the platform and paint layers are where it bends.

---

## 1. rendering-and-reactivity

**Rendering mode:** client-rendered, single-screen, **SPA-equivalent with no router**. There is no SSR, no SSG, no hydration, no React Server Components. The app boots, renders one component tree, and reconciles in place for the life of the process.

**Reconciliation model:** virtual-DOM diffing — the standard React reconciler — but the **host renderer is OpenTUI (`@opentui/react`), not react-dom** (`createRoot(renderer).render(<Chat …/>)`, `src/cli/chat.tsx:72`). React builds and diffs the element tree exactly as it does in a browser; OpenTUI's renderer commits the diff to **terminal cells** via a Zig native core (loaded over `bun:ffi`). Your `<box flexDirection="column">` (`chat.tsx:46`) is flex-laid-out text printed to stdout — not a real `<div>`. React 19.2.8. Runs under **Bun** (OpenTUI requires `bun:ffi`).

**Scheduling:** React 19.2.8 (`react@^19.2.8`, `package.json`). No `startTransition`, no Suspense, no concurrent features in use. Every `setState` schedules a reconcile that repaints the terminal frame.

**When work happens:** on mount and on every state update — two update sources: `setTurns`, `setBusy` (`chat.tsx:21–22`). The `turns.map()` (`chat.tsx:50`) re-runs on every render. The input field is **uncontrolled** — no `setInput` per keystroke, no `input` useState. The transcript re-renders on `turns` and `busy` changes only. → full walk in `01-react-without-the-dom.md`. The event-loop mechanics of how the awaited turn yields belong to `study-runtime-systems`.

---

## 2. state-architecture

The client state graph is **four `useState` hooks plus a `useRef` in one component** (`src/cli/chat.tsx`):

| state | type | role | who transitions it |
|-------|------|------|--------------------|
| `turns` | `Turn[]` | the transcript, append-only | `setTurns(t => [...t, …])` on submit and on answer/error |
| `busy` | `boolean` | loading flag, one turn in flight | `setBusy(true)` before the async hop, `setBusy(false)` in both `.then` and `.catch` |
| `status` | `string` | live spinner label ("searching Google…") | `onStatus` callback from `session.ask()` opts |
| `liveTokens` | `{input,output}` | live token counter, accumulated during turn | `onTokens` callback from `model_usage` events |
| `startRef` | `useRef<number>` | spinner start-time (NOT useState — avoids render on capture) | reset at each turn's mount |

Input text is **not in React state** — OpenTUI's `<input>` is uncontrolled: it holds its own text buffer and fires `onSubmit(value)` on Enter. No `onChange`, no `input` useState. Clearing is automatic via unmount/remount (the `busy` ternary at `chat.tsx:56`). → `05-uncontrolled-input-with-submit.md`.

**Local only.** No global store (Redux/Zustand), no Context, no lifted state, no URL/route state, no form library. Source-of-truth for the *conversation itself* lives **below the UI** — the persisted `conversations`/`messages` rows and the in-process `ChatSession` (`src/session.ts:55,60`). The component's `turns` is a **display projection**, not the canonical record; the canonical record is the DB. That split (display state vs server state) is the one genuinely interesting thing in this lens. → `02-hooks-state-in-a-cli.md`. System-level state ownership (warm pool, one conversation across turns) is owned by `study-system-design`.

---

## 3. component-architecture

**One component plus one helper, no composition tree to speak of.** `<Chat>` (`chat.tsx:20`) is the main application component; `<Spinner>` (`chat.tsx:11`) is a custom leaf that owns its own `setInterval` animation. The rest are OpenTUI primitives (`<box>`, `<text>`, `<input>`). No children/slots/render-props/compound/headless patterns — there's nothing to compose yet.

**The boundary that *does* exist is vertical, not within the tree:** the container/presentational seam between `<Chat>` (presentational: renders, owns ephemeral UI state) and `createChatSession` (container: owns data acquisition). `<Chat>` receives `session` as a prop (`chat.tsx:9`) — dependency injection — and never imports pg, the agent, or the embedder. That's the one component-architecture decision worth defending. → `04-session-as-the-data-layer.md`. Module/interface depth behind `ChatSession` is owned by `study-software-design`.

`<Spinner>` now takes two live props: `status` (updated by `onStatus` callbacks during tool calls — e.g. `"searching Brave"`) and `tokens` (accumulated from `onTokens` callbacks from `model_usage` events). It owns its own `useRef(Date.now())` start-time capture and `setInterval(100ms)` elapsed counter. This is a lean real-time component: no props drilling of the whole session, just the two live signals it needs.

---

## 4. data-fetching-and-cache

**One fetch path, no cache layer — but now with live callbacks.** Server state crosses into the UI through a single async hop: `session.ask(q, { onStatus, onTokens, onComplete }).then(…).catch(…)`. No react-query, no SWR, no route loaders, no optimistic updates, no cache invalidation, no retry/backoff in the UI. The three callbacks are the side-channel for live progress updates: `onStatus` drives `setStatus` (spinner label), `onTokens` accumulates `setLiveTokens`, `onComplete` captures `TurnStats` (durationMs, inputTokens, outputTokens) for the post-turn footer displayed after `setBusy(false)`. The core contract — one `ask()` awaited for the answer string — is unchanged; the callbacks are additive.

What *is* present is the **loading/success/error state machine** hand-rolled around that one call: `setBusy(true)` → `.then` success appends a `buffr` turn / `.catch` appends an error turn / both clear `busy` (`chat.tsx:32–41`). The re-entrancy guard `if (busy || !q) return` (`chat.tsx:26`) is the manual stand-in for what a query library's `isFetching` would gate. → `03-async-ui-with-a-busy-flag.md`.

Optimistic update — *partial*: the user's own turn is appended **before** the async hop resolves (`chat.tsx:31`), so the question shows instantly. The answer is not optimistic; it waits. The wire semantics under `ask()` (Ollama HTTP, pg protocol) belong to `study-networking`; the no-client-cache-because-the-DB-is-the-cache argument belongs to `study-system-design`.

---

## 5. routing-and-navigation

`not yet exercised`. One screen, one component, no routes, no navigation, no history, no deep-linking, no code-splitting at a route boundary. The only "navigation" is `/exit`/`/quit` tearing the app down (`chat.tsx:27–30`, `process.exit(0)` after `session.close()`), which is process teardown, not routing.

---

## 6. styling-and-design-system

`not yet exercised` as a *system*. Styling is **OpenTUI prop-level color only**: `fg="#888888"`/`fg="#00FFFF"`/`fg="#00FF00"`/`fg="#FFFF00"` and `attributes={TextAttributes.BOLD}` (from `@opentui/core`) (`chat.tsx:48,52–53`), and flex layout via `<box flexDirection marginBottom>`. No CSS, no CSS-in-JS, no CSS Modules, no design tokens, no theming, no responsive breakpoints, no animation system beyond the custom `<Spinner>` (braille frames + `setInterval`, `chat.tsx:11–17`). There is nothing to "scale as components grow" because there is one component and a fixed palette.

---

## 7. browser-platform-and-build

**Platform APIs:** the platform is the **TTY, not the browser**. No Storage / Worker / ServiceWorker / IndexedDB / WebSocket / EventSource. The one platform primitive in play is **raw-mode stdin**: OpenTUI (via its Zig native core over `bun:ffi`) puts the terminal into raw mode to capture keystrokes and drive `<input onSubmit focused />` (`chat.tsx:62`). That's the terminal analogue of a DOM input's keydown stream — but the model is **uncontrolled** (no value/onChange). → `05-uncontrolled-input-with-submit.md`.

**Build:** `tsc -p tsconfig.json` only, emitting **ESM** (`"type": "module"`; `module: NodeNext`). JSX compiles via `/** @jsxImportSource @opentui/react */` pragma at `chat.tsx:1` (required because `tsconfig.json` has `"types": ["node"]` which blocks automatic type augmentation). The deploy artifact is plain `.js` files under `dist/`. **`npm run chat` runs via Bun** (`bun dist/src/cli/chat.js`) — required because OpenTUI loads its Zig core via `bun:ffi`. All other scripts (`build`, `test`, `index`, `eval`, `migrate`) run via Node. No bundler (Vite/Webpack/esbuild), no tree-shaking, no code-splitting, no polyfills.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. All grounded; the top one is the only one that would actually surface.

**1. The transcript re-renders on every turn, not every keystroke (improvement over Ink era).** Because the `<input>` is **uncontrolled**, there is no `setInput` per keystroke — `turns.map()` (`chat.tsx:50`) only re-runs when `turns` or `busy` changes (once per turn, not per keypress). *Remaining concern:* the transcript list grows unbounded across a long session. `turns.map()` re-runs on every state update; at hundreds of turns each reconcile re-evaluates the whole list. *The move if it surfaces:* memoize the rendered turns with `React.memo` or extract them into a child. Inferred structurally, not measured — the measurement is `study-performance-engineering`'s.

**2. `turns` (display state) can drift from the DB (canonical state).** The transcript is rebuilt fresh each process start from `useState<Turn[]>([])` (`chat.tsx:21`) — it never reads back the persisted `messages`. *Consequence:* the on-screen history is session-local; a crash mid-turn loses the displayed transcript even though the user turn was persisted (`session.ts:62`). This is a deliberate split (display projection vs source of truth), not a bug — but it's the kind of state-can't-be-invalidated risk this lens names. Owned at the system level by `study-system-design`.

**3. No async-hop cancellation.** `session.ask(q)` (`chat.tsx:33`) can't be cancelled once started — there's no `AbortController`, and the `/exit` path can't interrupt an in-flight turn (the `busy` guard at `chat.tsx:26` blocks new input but the pending async hop runs to completion). *Consequence:* `/exit` during a slow model call waits for the call. Acceptable for a single-user local CLI; would matter the moment a turn could hang. Cancellation mechanics belong to `study-runtime-systems`.

**4. Error surface is a string in the transcript.** The `.catch` stringifies `(err as Error).message` into a `buffr` turn (`chat.tsx:39`). *Consequence:* no error type discrimination, no retry affordance — a transient pg blip and a real bug look identical to the user. Fine for a personal tool; thin for anything shared.

# Frontend audit — Pass 1, the 8 lenses

The frontend surface is one component, `<Chat>` (`src/cli/chat.tsx`), rendered by Ink to a terminal, sitting on a data façade (`createChatSession`, `src/session.ts`). This audit walks the eight frontend lenses against that surface. Where a lens finds nothing, it says `not yet exercised` — no invented patterns.

Calibration note for you: this is a terminal React UI. Treat every browser instinct as a hypothesis to check, not a given. Most of your hooks knowledge holds verbatim; the platform and paint layers are where it bends.

---

## 1. rendering-and-reactivity

**Rendering mode:** client-rendered, single-screen, **SPA-equivalent with no router**. There is no SSR, no SSG, no hydration, no React Server Components. The app boots, renders one component tree, and reconciles in place for the life of the process.

**Reconciliation model:** virtual-DOM diffing — the standard React reconciler — but the **host renderer is Ink, not react-dom** (`render(<Chat session={session} />)`, `src/cli/chat.tsx:63`). React builds and diffs the element tree exactly as it does in a browser; Ink's renderer (built on `react-reconciler` + Yoga for flexbox layout) commits the diff to **terminal cells** instead of DOM nodes. Your `<Box flexDirection="column">` (`chat.tsx:38`) is flexbox computed by Yoga and printed as spaced text — not a real `<div>`.

**Scheduling:** synchronous, default React 18 (`react@^18.3.1`, `package.json:21`). No `startTransition`, no Suspense, no concurrent features in use. Every `setState` schedules a reconcile that repaints the terminal frame.

**When work happens:** on mount (`render`, `chat.tsx:63`) and on every state update — three update sources: `setTurns`, `setInput`, `setBusy` (`chat.tsx:11–13`). The `turns.map()` (`chat.tsx:42`) re-runs on every render. The transcript is append-only and re-rendered whole each frame; under React's default behavior this list **re-renders on every keystroke** because `setInput` (`chat.tsx:55`) updates parent state and the `.map()` is in the same component — observed structurally, not measured. → full walk in `01-react-without-the-dom.md`. The event-loop mechanics of how the awaited turn yields belong to `study-runtime-systems`.

---

## 2. state-architecture

The entire client state graph is **three `useState` hooks in one component** (`src/cli/chat.tsx:11–13`):

| state | type | role | who transitions it |
|-------|------|------|--------------------|
| `turns` | `Turn[]` | the transcript, append-only | `setTurns(t => [...t, …])` on submit and on answer/error (`chat.tsx:25,29,31`) |
| `input` | `string` | controlled value of the text field | `onChange={setInput}` per keystroke (`chat.tsx:55`); cleared on submit (`chat.tsx:24`) |
| `busy` | `boolean` | loading flag, one turn in flight | `setBusy(true)` before the call, `setBusy(false)` in `finally` (`chat.tsx:26,32`) |

**Local only.** No global store (Redux/Zustand), no Context, no lifted state, no URL/route state, no form library. Source-of-truth for the *conversation itself* lives **below the UI** — the persisted `conversations`/`messages` rows and the in-process `ChatSession` (`src/session.ts:55,60`). The component's `turns` is a **display projection**, not the canonical record; the canonical record is the DB. That split (display state vs server state) is the one genuinely interesting thing in this lens. → `02-hooks-state-in-a-cli.md`. System-level state ownership (warm pool, one conversation across turns) is owned by `study-system-design`.

---

## 3. component-architecture

**One component, no composition tree to speak of.** `<Chat>` (`chat.tsx:9`) is the only application component; the rest are Ink primitives (`<Box>`, `<Text>`) and two third-party leaves (`<TextInput>`, `<Spinner>`). No children/slots/render-props/compound/headless patterns — there's nothing to compose yet.

**The boundary that *does* exist is vertical, not within the tree:** the container/presentational seam between `<Chat>` (presentational: renders, owns ephemeral UI state) and `createChatSession` (container: owns data acquisition). `<Chat>` receives `session` as a prop (`chat.tsx:9`) — dependency injection — and never imports pg, the agent, or the embedder. That's the one component-architecture decision worth defending. → `04-session-as-the-data-layer.md`. Module/interface depth behind `ChatSession` is owned by `study-software-design`.

---

## 4. data-fetching-and-cache

**One fetch path, no cache layer.** Server state crosses into the UI through a single awaited call: `const answer = await session.ask(q)` (`chat.tsx:28`). No react-query, no SWR, no route loaders, no optimistic updates, no cache invalidation, no retry/backoff in the UI.

What *is* present is the **loading/success/error state machine** hand-rolled around that one call: `setBusy(true)` → `await` → success appends a `buffr` turn (`chat.tsx:29`) / `catch` appends an error turn (`chat.tsx:31`) / `finally` clears `busy` (`chat.tsx:32`). The re-entrancy guard `if (busy) return` (`chat.tsx:17`) is the manual stand-in for what a query library's `isFetching` would gate. → `03-async-ui-with-a-busy-flag.md`.

Optimistic update — *partial*: the user's own turn is appended **before** the await resolves (`chat.tsx:25`), so the question shows instantly. The answer is not optimistic; it waits. The wire semantics under `ask()` (Ollama HTTP, pg protocol) belong to `study-networking`; the no-client-cache-because-the-DB-is-the-cache argument belongs to `study-system-design`.

---

## 5. routing-and-navigation

`not yet exercised`. One screen, one component, no routes, no navigation, no history, no deep-linking, no code-splitting at a route boundary. The only "navigation" is `/exit`/`/quit` tearing the app down (`chat.tsx:18–22`, `useApp().exit()`), which is process teardown, not routing.

---

## 6. styling-and-design-system

`not yet exercised` as a *system*. Styling is **Ink prop-level color and weight only**: `color="cyan"`/`"green"`/`"yellow"` (`chat.tsx:44,49,54`), `bold` (`chat.tsx:44`), `dimColor` (`chat.tsx:40`), and flexbox layout via `<Box flexDirection marginBottom>` (`chat.tsx:38,39,43`). No CSS, no CSS-in-JS, no CSS Modules, no design tokens, no theming (dark mode / brand), no responsive breakpoints, no animation system beyond the third-party `<Spinner>`. There is nothing to "scale as components grow" because there is one component and a fixed palette.

---

## 7. browser-platform-and-build

**Platform APIs:** the platform is the **TTY, not the browser**. No Storage / Worker / ServiceWorker / IndexedDB / WebSocket / EventSource. The one platform primitive in play is **raw-mode stdin**: Ink + `ink-text-input` put the terminal into raw mode to capture keystrokes char-by-char and drive `<TextInput value/onChange/onSubmit>` (`chat.tsx:55`). That's the terminal analogue of a DOM input's keydown stream. → `05-controlled-text-input.md`.

**Build:** `tsc -p tsconfig.json` only (`package.json:7`), emitting **ESM** (`"type": "module"`, `package.json:3`; `module: NodeNext`, `tsconfig.json:4`). JSX compiles via the **automatic runtime** (`jsx: react-jsx`, `tsconfig.json:13`) — no `import React` needed, which is why `chat.tsx:1` imports only `useState`. The deploy artifact is plain `.js` files under `dist/`, run by Node (`node dist/src/cli/chat.js`, `package.json:12`). No bundler (Vite/Webpack/esbuild), no tree-shaking, no code-splitting, no sourcemaps config, no polyfills. Bundle-size *measurement* would belong to `study-performance-engineering` — but there is no bundle, so it's `not yet exercised`.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. All grounded; the top one is the only one that would actually surface.

**1. The transcript re-renders on every keystroke.** `setInput` (`chat.tsx:55`) updates state on `<Chat>`, and the `turns.map()` (`chat.tsx:42`) lives in the same component, so every keypress re-runs the whole transcript render. *Consequence:* on a long conversation, typing latency grows with transcript length — each keystroke reconciles N turns. Today N is small and the terminal repaint is cheap, so it's invisible; it becomes visible at hundreds of turns. *The move:* split the input into its own child component so `input` state lives below the transcript, or memoize the rendered turns. Inferred under React's default behavior, not measured — the measurement is `study-performance-engineering`'s.

**2. `turns` (display state) can drift from the DB (canonical state).** The transcript is rebuilt fresh each process start from `useState<Turn[]>([])` (`chat.tsx:11`) — it never reads back the persisted `messages`. *Consequence:* the on-screen history is session-local; a crash mid-turn loses the displayed transcript even though the user turn was persisted (`session.ts:62`). This is a deliberate split (display projection vs source of truth), not a bug — but it's the kind of state-can't-be-invalidated risk this lens names. Owned at the system level by `study-system-design`.

**3. No `await` cancellation.** `session.ask(q)` (`chat.tsx:28`) can't be cancelled once started — there's no `AbortController`, and the `/exit` path can't interrupt an in-flight turn (the `busy` guard at `chat.tsx:17` blocks new input but the awaited turn runs to completion). *Consequence:* `/exit` during a slow model call waits for the call. Acceptable for a single-user local CLI; would matter the moment a turn could hang. Cancellation mechanics belong to `study-runtime-systems`.

**4. Error surface is a string in the transcript.** The `catch` stringifies `(err as Error).message` into a `buffr` turn (`chat.tsx:31`). *Consequence:* no error type discrimination, no retry affordance — a transient pg blip and a real bug look identical to the user. Fine for a personal tool; thin for anything shared.

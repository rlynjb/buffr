# Frontend audit — Pass 1, the 8 lenses

The frontend surface is still one component, `<Chat>` (`src/cli/chat.tsx`, now 474 lines — up from ~160 at the last audit), rendered by **OpenTUI** (`@opentui/react`) to a terminal via a Zig native core (`bun:ffi`), sitting on a data façade (`createChatSession`, `src/session.ts`). Runs under **Bun** (not Node). This audit walks the eight frontend lenses against that surface. Where a lens finds nothing, it says `not yet exercised` — no invented patterns.

Since the last sync, `<Chat>` grew two things that change the shape of this guide: an **interactive multi-turn flow state machine** (`research-flow.ts` / `review-flow.ts`, wired in via `activeFlow`) and a **live per-step progress panel** (`ProgressPanel`/`StepList`) that streams engine progress instead of a single spinner label. Both earn dedicated pattern files this update — `06-multi-step-flow-as-state-machine.md` and `07-streaming-progress-panel.md`.

Calibration note for you: this is a terminal React UI. Treat every browser instinct as a hypothesis to check, not a given. Most of your hooks knowledge holds verbatim; the platform and paint layers are where it bends.

---

## 1. rendering-and-reactivity

**Rendering mode:** unchanged — client-rendered, single-screen, **SPA-equivalent with no router**. No SSR, no SSG, no hydration, no RSC. The app boots, renders one component tree, and reconciles in place for the life of the process.

**Reconciliation model:** unchanged — virtual-DOM diffing via React 19.2.8, host renderer **OpenTUI** (`createRoot(renderer).render(<Chat …/>)`, `src/cli/chat.tsx:468`), committed to terminal cells through a Zig native core over `bun:ffi`.

**Scheduling:** still no `startTransition`, no Suspense, no concurrent features. What's new: the update surface is wider. Six render-triggering `useState` calls now live in `<Chat>` (`turns`, `busy`, `activeFlow`, `status`, `liveTokens`, `progressSteps` — `chat.tsx:122–135`), plus a nested `ProgressPanel` with its own `frame`/`elapsedMs` state ticking every 100ms (`chat.tsx:91–92`, `useEffect` at `96–104`). During a `/research` turn, three independent clocks can all be scheduling repaints at once: the outer React reconcile on `progressSteps` updates, the `ProgressPanel`'s own 100ms interval, and the underlying engine's async event stream pushing new steps. → full walk in `07-streaming-progress-panel.md`.

**When work happens — a new imperative escape hatch:** `<scrollbox stickyScroll>`'s built-in auto-scroll heuristic could latch and stop following new content (commit `ebe1e65`). The fix adds an explicit `useEffect` that force-scrolls on every relevant state change:

```tsx
// chat.tsx:142–144
useEffect(() => {
  scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
}, [turns, busy, progressSteps, status]);
```

This is a **declarative dependency list driving an imperative DOM-equivalent call** — precisely the "escape hatch" shape you know from `ref.current.scrollIntoView()` in a browser `useEffect`. The dependency array (`turns, busy, progressSteps, status`) is doing double duty: it's not just "when new turns arrive," it's "on every signal that could have grown the visible content," including the live progress panel ticking during a still-open turn. Miss one of those four and the transcript can silently stop tracking the latest line. Cross-link: the event-loop mechanics of `setInterval`/scheduling belong to `study-runtime-systems`.

---

## 2. state-architecture

The client state graph roughly **tripled** since the last audit — six `useState` hooks plus three `useRef`s in `<Chat>`, plus one more `useState`/`useRef` pair inside `ProgressPanel`:

| state | type | role | who transitions it |
|-------|------|------|--------------------|
| `turns` | `Turn[]` | the transcript, append-only; now carries optional `progressSteps` and `helpLines` per entry | `setTurns(t => [...t, …])` across every command branch |
| `busy` | `boolean` | loading flag, one turn *or one flow step* in flight | `setBusy(true)` before each async hop, `setBusy(false)` in both `.then`/`.catch` branches |
| `activeFlow` | `{ kind: 'research' \| 'review'; controller } \| null` | **new** — which multi-turn flow (if any) owns the next input | set on `/research`/`/review` start, cleared on `/cancel`, `done`, or error → `06-multi-step-flow-as-state-machine.md` |
| `status` | `string` | live label shown above the spinner/panel | `onStatus` callback from `session.ask()`/`analyze()`/flow calls |
| `liveTokens` | `{input,output}` | live token counter | `onTokens` callback from `model_usage` events |
| `progressSteps` | `ProgressStep[]` | **new** — the ordered list of engine/connector/stage steps rendered live | `updateProgressSteps` (`chat.tsx:146–152`), fed by `onProgress` |
| `progressStepsRef` | `useRef<ProgressStep[]>` | **new** — a ref mirror of `progressSteps`, kept in sync by `updateProgressSteps` | written alongside every `setProgressSteps` call; read inside `.then` callbacks after the async hop resolves |
| `taRef` | `useRef<any>` | ref to the `<textarea>` node | unchanged — `.plainText`, `.setText('')`, `.newLine()` |
| `scrollRef` | `useRef<any>` | **new** — ref to the `<scrollbox>`, used to force `scrollTo` | read in the autoscroll `useEffect` (lens 1) |
| `startRef` (inside `ProgressPanel`) | `useRef<any>` | spinner/panel start-time | reset in `ProgressPanel`'s own `useEffect` on mount |

**The load-bearing new piece is `progressStepsRef`.** `progressSteps` is read at the end of an async flow (`controller.submit(q).then(result => { const steps = progressStepsRef.current.map(...) ... })`, `chat.tsx:172`) to freeze the final step list onto the completed turn. Reading `progressSteps` (the `useState` value) directly there would close over whatever value was captured when the `.then` callback was *created*, not the latest value after all the `onProgress` events fired during the `await`. `progressStepsRef.current` always holds the latest — the same "stale closure across an await" problem `02-hooks-state-in-a-cli.md` already named for `turns`, now solved with a second technique (ref mirror) instead of a functional updater, because the read happens **after** the state has already stopped changing and needs a snapshot, not an update. → full walk in `07-streaming-progress-panel.md`.

**`activeFlow` is state that owns a closure, not just data.** Its `controller` field (`ResearchFlow`/`ReviewFlow`) is an object returned by `createResearchFlow`/`createReviewFlow` that closes over its *own* private step/prediction/stake variables — a hidden state machine living **outside** React state, referenced *through* React state. `<Chat>` doesn't know or care what step the flow is on; it just calls `activeFlow.controller.submit(q)` and renders whatever comes back. → `06-multi-step-flow-as-state-machine.md`.

**Still local only.** No global store, no Context, no URL/route state, no form library. Source-of-truth for the conversation and for decisions/reviews still lives **below the UI** (Postgres, via `session.ts` / `PgJournalStore`). `turns` is still a **display projection**. → `02-hooks-state-in-a-cli.md`. System-level state ownership is `study-system-design`.

---

## 3. component-architecture

**Still two components plus OpenTUI primitives — but the leaf-component count has grown.** `<Chat>` is the main application component. New leaves since the last audit:

- **`<ProgressPanel>`** (`chat.tsx:86–119`) — replaces the bare `<Spinner>` label with an animated frame, elapsed time, token count, *and* a live `<StepList>`. Owns its own `frame`/`elapsedMs` state and a 100ms `setInterval`, same shape as the old `<Spinner>` it superseded.
- **`<StepList>`** (`chat.tsx:63–84`) — a pure, stateless renderer of `ProgressStep[]` → text lines. Used in **two places**: live, inside `<ProgressPanel>` while `busy` (`chat.tsx:431`), and frozen, attached to a completed turn's `progressSteps` field (`chat.tsx:416–418`). Same component, two different data sources (live ref-driven state vs. a static array baked onto a turn) — this dual-use is why it's a separate component rather than inlined into `ProgressPanel`.
- **`<HelpLine>`** (`chat.tsx:35–45`) — a small formatting component for `/help` output; regex-detects command lines (`/research`, `<anything else>`) and label lines (`Connectors:`, `Example:`) to dim them gray, everything else renders plain (commit `087f8bf`).

**The vertical boundary is unchanged in kind, wider in surface.** `<Chat>` (presentational, owns ephemeral UI state) vs `createChatSession` (container, owns data acquisition) still holds — `<Chat>` now also receives `initialDueCount: number` as a third prop (`chat.tsx:121`), still pure dependency injection, no new backend imports. → `04-session-as-the-data-layer.md`.

**What's new and *not* a React component:** `createResearchFlow`/`createReviewFlow` (`src/cli/research-flow.ts`, `src/cli/review-flow.ts`) are plain factory functions returning `{ start(), submit() }` objects — the same "smart factory, dumb caller" seam `04-session-as-the-data-layer.md` already documents for `createChatSession`, applied one layer up: `<Chat>` doesn't know the flow's internal step machine any more than it knows about Postgres. → `06-multi-step-flow-as-state-machine.md`.

---

## 4. data-fetching-and-cache

**Two fetch shapes now, not one.** The original single-shot shape (`session.ask()`, `.analyze()`, `.evalInvesting()`, `.evalResearch()` — one `await`, one `.then`/`.catch` pair, `busy` resets after) is unchanged and still the default path (`chat.tsx:358–377` for the bare-question case).

**New: a *sequenced* fetch shape for `/research` and `/review`.** Each keystroke while `activeFlow` is set becomes its own `await activeFlow.controller.submit(q)` round-trip (`chat.tsx:170`) — the flow controller may itself call back into `session.researchEvaluate()`, `session.saveDecision()`, `session.snoozeReview()`, etc., depending on which internal step it's on. From the fetching lens this is **N sequential requests gated by user input between each one**, where N and the request shape depend on runtime branching inside the controller, not on anything `<Chat>` decides. → `06-multi-step-flow-as-state-machine.md`.

**New: progress streamed mid-flight via `onProgress`, not just `onStatus`.** `session.researchCollect()`/`researchEvaluate()` accept an `onProgress: (event: ProgressEvent) => void` callback (`packages/engines/market-research/src/types.ts:18–24`) firing a typed union — `engine-start`, `connector-start`, `connector-done`, `connector-failed`, `stage-start`, `stage-done` — as each collector/analyzer/scorer/teacher stage completes, in real time (not batched after the fact; commit `03e3dbd` changed the Collector to fire per-connector as each fetch *settles*, not after all settle). This is a second, richer callback channel layered on top of the existing `onStatus`/`onTokens` pair. → `07-streaming-progress-panel.md`.

**Error handling was extended to the new call sites (commit `26f0e4b`).** The active-flow interceptor, `/research` start, and `/review` start were initially wired with a single-argument `.then(result => …)` — no rejection handler — which meant a DB or engine error left `busy` stuck `true` and the input permanently hidden (no way to recover without restarting the process). The fix converts all three to the two-argument `.then(onSuccess, onError)` form already used by `/investing`, `/eval`, and the bare-question path, resetting `busy` and clearing `activeFlow` on rejection:

```tsx
// chat.tsx:170–189 — the pattern now applied uniformly across all seven async call sites
activeFlow.controller.submit(q).then(
  result => { /* … setBusy(false); if (result.step === 'done') setActiveFlow(null); */ },
  err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); setActiveFlow(null); },
);
```

This is the same lesson `03-async-ui-with-a-busy-flag.md` already teaches about `finally`-equivalence — a promise chain with only a success handler is a UI that can wedge — now shown as a bug that actually shipped and got fixed, across three call sites at once, in a single commit. → note added to `03-async-ui-with-a-busy-flag.md`.

**Still no react-query/SWR, no cache, no invalidation, no optimistic mutations for the flow steps** (each flow step's request is pessimistic — the UI waits for `submit()` to resolve before showing the next prompt).

---

## 5. routing-and-navigation

`not yet exercised` as URL/history routing — still one screen, no routes. But the "navigation" surface inside `handleSubmit` grew a second dispatch layer:

**New: a soft-modal input router.** The very top of `handleSubmit` now branches on `activeFlow` *before* it looks at the input string at all (`chat.tsx:160–191`):

```tsx
// chat.tsx:157–191 (condensed)
if (!activeFlow && !q) return;
if (activeFlow) {
  if (q.toLowerCase() === '/cancel') { /* bail out of the flow */ }
  // otherwise: ALL input routes to activeFlow.controller.submit(q), not slash-command matching
  return;
}
// only reached when activeFlow is null — the normal slash-command dispatch below
```

This is the same shape as a modal dialog capturing all keyboard focus in a browser app — while `activeFlow` is set, the slash-command dispatch table below (`/help`, `/investing`, `/research`, `/eval*`, `/review`) is **unreachable**; every submission is forwarded to the flow's `submit()`, with `/cancel` as the one universal escape hatch. → `06-multi-step-flow-as-state-machine.md`.

**Slash-command table, current state:**
- `/exit` / `/quit` (`chat.tsx:193–196`) — process teardown, unchanged.
- `/help` (`chat.tsx:197–235`) — **new since last audit**. Builds a connector-aware help block from `session.connectorStatus()`, rendered through the new `helpLines`/`<HelpLine>` path instead of plain `text`.
- `/investing <TICKER>` (`chat.tsx:236–254`) — unchanged shape.
- `/research` (`chat.tsx:255–316`) — **now branches in two directions**: bare `/research` with no topic calls `session.suggestResearchTopics()` for a one-shot trending-topics answer (commit `602ec62`); `/research <topic>` starts the multi-turn flow via `createResearchFlow(...).start()` and, if the flow isn't `done` after one step, sets `activeFlow`.
- `/eval investing` / `/eval research` / `/eval` (`chat.tsx:317–339`) — unchanged.
- `/review` (`chat.tsx:340–357`) — **new**. Starts `createReviewFlow(session).start()`; sets `activeFlow` if the flow isn't immediately `done` (i.e., there's at least one due decision to walk through).
- default (anything else) → `session.ask()` (`chat.tsx:358–377`) — unchanged.

**New: a startup notification, not a route, but a first-turn injection.** `initialDueCount` (fetched via `session.dueReviewCount()` before render, `chat.tsx:461`) seeds `turns` with a synthetic `buffr` turn on mount if any decisions are due (`chat.tsx:122–126`) — "3 decisions due for review. Run /review when ready." This is the closest thing to a "redirect on load" this app has: no navigation happens, but the transcript's initial state is conditional on server state fetched before the component ever renders.

**New: Ctrl+C handled in the same `useKeyboard` hook as Enter** (`chat.tsx:379–383`) — `e.ctrl && e.name === 'c'` calls `onExit()` directly, ahead of the Enter/Alt+Enter branching. Same interception layer as the textarea's Enter-vs-newline split (`05-uncontrolled-input-with-submit.md`), just a second key pattern matched first.

**Still zero tests on any of these handlers**, including the two new flow-start branches and the `/cancel` path. → see `study-testing/audit.md`.

---

## 6. styling-and-design-system

`not yet exercised` as a *system* — unchanged. Palette additions since the last audit:

- Help output: command lines (`/research`, `<anything else>`) dim to `fg="#888888"`; label prefixes (`Connectors:`, `Example:`, `Knowledge base:`) dim the same gray, rest of the line stays `#E8E8E8` (commit `087f8bf`, `HelpLine` at `chat.tsx:35–45`).
- Progress steps: state-keyed colors via `stepColor()` (`chat.tsx:56–61`) — running `#FFFF00` (yellow, matches the old spinner), done `#00EE66` (green, matches the "buffr" label color), failed `#FF5555` (red, new), skipped `#555555` (dimmed gray, new — used for optional connectors that failed, e.g. Google Trends without the required HTML guard).
- Step icons: `stepIcon()` (`chat.tsx:49–54`) — animated braille frames while running, `✓`/`✗`/`⊘` (skip) once settled. Same frame set (`FRAMES`) reused from the original spinner.

Layout structure is unchanged (`<box flexDirection="column">` root, `<scrollbox>` transcript, rounded-border input). No CSS-in-JS, no tokens, no theming. There is still nothing to "scale as components grow" — the growth this update was in *state and flow logic*, not visual surface.

---

## 7. browser-platform-and-build

**Platform APIs — one new imperative primitive.** Everything from the last audit holds (`useKeyboard`, `<textarea ref>`, `bun:ffi`), plus:

- **`<scrollbox ref={scrollRef}>`** (`chat.tsx:405`) — previously the scrollbox was used purely declaratively (`stickyScroll stickyStart="bottom"` and nothing else). It's now also driven imperatively via a ref, calling `.scrollTo(Number.MAX_SAFE_INTEGER)` to force-follow new content when the built-in heuristic doesn't (lens 1). This is the terminal-UI equivalent of `ref.scrollIntoView()` — declarative-by-default, with an imperative override for the case the default heuristic can't reliably detect.

**Build:** unchanged — monorepo, `npm run build:packages` then `tsc`, Bun launches the compiled `dist/src/cli/chat.js`. New workspace packages touched by this update: `@buffr/engine-market-research` (added `collect()`/`evaluate()` split and `ProgressEvent`), `@buffr/kernel` (added `journal/` — `JournalStore` contract + `InMemoryJournalStore`), consumed the same way as before (built library, not edited at root). No change to the bundler story: still no Vite/Webpack, no tree-shaking, no code-splitting.

---

## 8. frontend-red-flags-audit

Ranked by user-visible consequence.

**1. `handleSubmit` is now a 220-line function covering nine distinct command branches plus the flow interceptor (`chat.tsx:154–377`).** Each new slash command (`/help`, `/review`, the two `/research` shapes) was added as another `if (q === …)` block inside the same function, following the established idiom, but the function itself has not been decomposed. The `activeFlow` early-return at the top (lens 5) is now load-bearing routing logic sharing a function with straight-line command dispatch — a reader has to hold "is a flow active" in mind while scanning past it to find the command they're looking for. Not yet a correctness problem (branches are self-contained, each still returns early), but the next slash command is the one that tips this into "needs extraction" territory. The move: extract a `dispatchCommand(q, ctx)` table keyed by command prefix, called only when `!activeFlow`.

**2. Rejection handling was missing on three call sites for one commit, and shipped that way briefly (commits `1344d9b` → `26f0e4b`).** This is the fixed version of the finding, but it's worth naming as a *pattern to watch for*: every new `.then(onSuccess)`-only call site in this file is a latent "stuck on the spinner forever" bug, because `busy` only resets in the success branch. There is no lint rule or type that catches a missing second `.then` argument — it's purely a code-review discipline. → `03-async-ui-with-a-busy-flag.md`, `06-multi-step-flow-as-state-machine.md`.

**3. `progressStepsRef` is a second source of truth for the same data as `progressSteps`, kept in sync by convention.** `updateProgressSteps` (`chat.tsx:146–152`) writes both on every call, but nothing enforces that every `setProgressSteps` call goes through `updateProgressSteps` rather than calling `setProgressSteps` directly — a future edit that bypasses the helper silently desyncs the ref from the state. This is the same shape of risk as any manually-synced cache, just scoped to one component. The move if it recurs elsewhere: a single `useProgressSteps()` hook that returns both and only exposes the paired setter.

**4. `<scrollbox>` still re-renders the whole transcript on every turn; unbounded list growth is unmeasured.** Unchanged from the last audit — now compounded by `progressSteps` re-renders firing at up to 10Hz (100ms interval) while a flow step is in flight, on top of the OpenTUI keyed-list diff. Inferred structurally, not measured — belongs to `study-performance-engineering`.

**5. `turns` (display state) still drifts from the DB (canonical state) on crash** — unchanged, deliberate split, documented in `02-hooks-state-in-a-cli.md`.

**6. No async-hop cancellation, now across more call sites.** `/research`'s multi-turn flow and `/review`'s per-item loop both inherit the same "no `AbortController`, `busy` blocks new input but can't interrupt in-flight work" limitation the single-shot `ask()` already had — and now a stuck flow step means the user can't even `/cancel` until the in-flight `submit()` resolves or rejects, since `activeFlow`'s interceptor itself is gated by the same `busy` flag.

**7. `taRef`, `scrollRef`, and `startRef` (in `ProgressPanel`) are all typed `any`.** Unchanged limitation — OpenTUI doesn't export typed refs — now with one more instance (`scrollRef`) added to the pile.

---

## Pass 2 — pattern files this repo earns

See `06-multi-step-flow-as-state-machine.md` (the `activeFlow` union + flow-controller factories) and `07-streaming-progress-panel.md` (the `ProgressPanel`/`StepList`/`onProgress` stream) for the two patterns this update adds. Both pass the load-bearing test: strip the flow-state-machine and `/research`/`/review` collapse to single-shot commands with no way to ask a sequence of follow-up questions; strip the streaming panel and the user sees one static "thinking…" label for a 10-30 second multi-stage pipeline with no visibility into what's actually running.

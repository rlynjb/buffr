# Overview — the frontend in one page

The frontend of `buffr-laptop` is a **terminal React UI (OpenTUI)**, not a browser app. One component, one set of hooks, one data seam. If you skim only this file, here's the whole thing.

## The rendering mode, in one sentence

Single-component **client-rendered SPA-equivalent** that reconciles through a virtual-DOM diff (OpenTUI) and commits to the **terminal grid** instead of the browser DOM — no SSR, no hydration, no routing, no bundler. React renders; OpenTUI's renderer paints text cells via a Zig native core (`src/cli/chat.tsx:72`). Runs under **Bun** (OpenTUI requires `bun:ffi`).

## The state architecture, in one diagram

The state graph grew from two `useState` hooks to six, plus three `useRef`s — still all local to one component. No store, no context, no lifted state, no URL state.

```
  State graph — all local, all in <Chat>   (src/cli/chat.tsx:122–140)

  ┌─ <Chat> component (the only stateful node) ──────────────────┐
  │                                                                │
  │   turns:         Turn[]   ← transcript (now carries per-turn  │
  │                              progressSteps/helpLines too)      │
  │   busy:          boolean  ← a turn OR a flow step in flight    │
  │   activeFlow:    {kind,controller} | null  ← which multi-turn  │
  │                     flow (if any) owns the next keystroke      │
  │   status:        string   ← live label above the panel         │
  │   liveTokens:    {input,output}  ← live token counter           │
  │   progressSteps: ProgressStep[]  ← live per-step engine trace  │
  │   progressStepsRef / taRef / scrollRef  ← refs: post-await      │
  │                     snapshot, textarea buffer, forced autoscroll│
  │                                                                │
  │   every render reads the useState six; every setState          │
  │   schedules a reconcile → terminal repaint                     │
  └────────────────────────────────────────────────────────────────┘
        no Redux · no Zustand · no Context · no URL state
        source of truth for the conversation lives BELOW, in session.ts
        activeFlow's controller holds its OWN state machine, outside React
```

Input text is still not in React state — OpenTUI's `<textarea ref={taRef}>` is **uncontrolled** (it replaced a single-line `<input>`; multiline needs `useKeyboard` to intercept Enter vs Alt+Enter, see `05-uncontrolled-input-with-submit.md`). The widget holds the text internally; React reads it once at submit via `taRef.current.plainText` and clears it with `.setText('')`.

## The data seam, in one diagram

Server state (the agent's answer, pulled from the DB + Ollama) crosses into client state through one façade call: `session.ask()`. The component never touches pg, the embedder, or the agent — it `await`s one method. This is the container/presentational seam, drawn as a vertical boundary.

```
  Data seam — UI never touches the backend directly

  ┌─ Presentation (UI layer) ──────────────────────────┐
  │  <Chat>  (src/cli/chat.tsx)                         │
  │    renders turns · owns input/busy · calls ↓        │
  └───────────────────────┬─────────────────────────────┘
                          │  session.ask(q)   ← the ONLY hop
                          │  returns Promise<string>
  ┌─ Data layer (the container) ─▼─────────────────────┐
  │  createChatSession()  (src/session.ts:34)          │
  │    warm pg Pool · one conversation · agent built    │
  │    once · per-turn persist → answer → remember      │
  └───────────────────────┬─────────────────────────────┘
                          │  pg protocol · Ollama HTTP
  ┌─ Storage / Provider ──▼─────────────────────────────┐
  │  Postgres + pgvector (reindb)  ·  Ollama (gemma2)   │
  └──────────────────────────────────────────────────────┘
```

## The highest-leverage frontend patterns

1. **The container/presentational seam** (`session.ts` ↔ `<Chat>`) — `src/session.ts:34` ↔ `src/cli/chat.tsx`. The component is presentational; all data acquisition hides behind `ChatSession`. Strip it and the UI grows a pg pool and an agent loop inside a React component. → `04-session-as-the-data-layer.md`

2. **The loading state** (the `busy` flag) — `src/cli/chat.tsx:127,156,169`. The loading/success/error machine around every awaited call, closed with a two-argument `.then(onSuccess, onError)` pair. It guards re-entrancy (`if (busy) return`) and swaps the input for a progress panel. Now guards nine call sites, not one. → `03-async-ui-with-a-busy-flag.md`

3. **The reconciler (OpenTUI)** — `src/cli/chat.tsx:468`. React's component model and diffing, paint target swapped from DOM to terminal. Your `key={i}` on the `.map()`, your conditional render, your `<box>`/`<text>` — all the same instincts, a different commit phase via OpenTUI's Zig native core. → `01-react-without-the-dom.md`

4. **Multi-step flow as a state machine** (`activeFlow`) — `src/cli/research-flow.ts`, `src/cli/review-flow.ts`. `/research` and `/review` drive a sequence of chat turns from a closure-held FSM (`start()`/`submit()`), with `<Chat>` routing input to it while blind to which of its five internal steps is active. Strip it and `/research`/`/review` collapse to single-shot commands with no follow-up questions. → `06-multi-step-flow-as-state-machine.md`

5. **Streaming progress panel** (`ProgressPanel`/`StepList`) — `src/cli/chat.tsx:63–119`. A typed `ProgressEvent` union, reduced live into a per-step checklist during `/research`/`/investing`, then frozen onto the finished turn instead of vanishing. Strip it and a 10-30 second multi-stage pipeline shows one static "thinking…" label. → `07-streaming-progress-panel.md`

## What this repo does NOT exercise (honest inventory)

- **Routing / navigation** — `not yet exercised`. One screen, no routes, no history.
- **CSS / styling / design system** — `not yet exercised` beyond OpenTUI `fg`/`bg` color props and `TextAttributes.BOLD`. No tokens, no theming, no responsive strategy.
- **DOM / browser platform** — `not yet exercised`. The platform is the TTY, not the web.
- **SSR / hydration / RSC** — `not yet exercised`. Pure client render.
- **Bundler** — `not yet exercised`. `tsc` only; no Vite/Webpack, no tree-shaking, no code-splitting.
- **HTTP client-fetch from the UI** — `not yet exercised`. The component never fetches; the data layer does, below the seam.
- **Web a11y** (ARIA, focus management, screen readers) — `not yet exercised`; the platform is a terminal.
- **Data-fetch cache layer** (react-query / SWR / optimistic updates) — `not yet exercised`. One direct `await`, no client cache, no invalidation.

See `audit.md` for the full 8-lens walk with `file:line` grounding.

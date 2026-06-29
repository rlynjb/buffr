# Overview — the frontend in one page

The frontend of `buffr-laptop` is a **terminal React UI (Ink)**, not a browser app. One component, one set of hooks, one data seam. If you skim only this file, here's the whole thing.

## The rendering mode, in one sentence

Single-component **client-rendered SPA-equivalent** that reconciles through a virtual-DOM diff (Ink) and commits to the **terminal grid** instead of the browser DOM — no SSR, no hydration, no routing, no bundler. React renders; Ink's renderer paints text cells (`src/cli/chat.tsx:63`).

## The state architecture, in one diagram

The entire state graph is three `useState` hooks in one component. No store, no context, no lifted state, no URL state.

```
  State graph — all local, all in <Chat>   (src/cli/chat.tsx:11–13)

  ┌─ <Chat> component (the only stateful node) ─────────────────┐
  │                                                              │
  │   turns:  Turn[]    ← the transcript (append-only log)       │
  │   input:  string    ← controlled value of the text field    │
  │   busy:   boolean   ← is a turn in flight? (loading state)   │
  │                                                              │
  │   every render reads these; every setState schedules         │
  │   a reconcile → terminal repaint                             │
  └──────────────────────────────────────────────────────────────┘
        no Redux · no Zustand · no Context · no URL state
        source of truth for the conversation lives BELOW, in session.ts
```

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

## The three highest-leverage frontend patterns

1. **The container/presentational seam** (`session.ts` ↔ `<Chat>`) — `src/session.ts:34` ↔ `src/cli/chat.tsx:55`. The component is presentational; all data acquisition hides behind `ChatSession`. Strip it and the UI grows a pg pool and an agent loop inside a React component. → `04-session-as-the-data-layer.md`

2. **The loading state** (the `busy` flag) — `src/cli/chat.tsx:13,16,26,32`. The loading/success/error machine around `await session.ask()`, closed with `try/finally`. It guards re-entrancy (`if (busy) return`) and swaps the input for a spinner. → `03-async-ui-with-a-busy-flag.md`

3. **The reconciler (Ink)** — `src/cli/chat.tsx:63`. React's component model and diffing, paint target swapped from DOM to terminal. Your `key={i}` on the `.map()`, your conditional render, your `<Box>`/`<Text>` — all the same instincts, a different commit phase. → `01-react-without-the-dom.md`

## What this repo does NOT exercise (honest inventory)

- **Routing / navigation** — `not yet exercised`. One screen, no routes, no history.
- **CSS / styling / design system** — `not yet exercised` beyond Ink color/`bold`/`dimColor` props. No tokens, no theming, no responsive strategy.
- **DOM / browser platform** — `not yet exercised`. The platform is the TTY, not the web.
- **SSR / hydration / RSC** — `not yet exercised`. Pure client render.
- **Bundler** — `not yet exercised`. `tsc` only; no Vite/Webpack, no tree-shaking, no code-splitting.
- **HTTP client-fetch from the UI** — `not yet exercised`. The component never fetches; the data layer does, below the seam.
- **Web a11y** (ARIA, focus management, screen readers) — `not yet exercised`; the platform is a terminal.
- **Data-fetch cache layer** (react-query / SWR / optimistic updates) — `not yet exercised`. One direct `await`, no client cache, no invalidation.

See `audit.md` for the full 8-lens walk with `file:line` grounding.

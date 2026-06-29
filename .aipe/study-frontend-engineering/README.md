# Frontend Engineering — `buffr-laptop`

The frontend layer of this repo is a React app that renders to a terminal instead of a
browser. One component, three hooks, one async seam. This guide treats that surface as
what it is: your seven years of React, applied to an unfamiliar host. No on-ramp on what
a hook or a controlled input is — you wrote those before. The new idea is the render
target (stdout via Ink), and the guide is built around making *that* click.

## Reading order

1. **`00-overview.md`** — one page. The rendering mode in a sentence, the state graph in
   one diagram, the network seam in one diagram, the three patterns named with files.
   Skim only this and you know the whole surface.
2. **`audit.md`** — the 8-lens frontend audit. What each lens finds, or `not yet exercised`
   stated honestly. Lenses 5–7 (routing, styling, browser/build) are mostly N/A and say so.
3. **Pattern files** (Pass 2) — one per pattern the repo actually exercises:
   - `01-react-without-the-dom.md` — the reconciler-vs-host-renderer split; how Ink paints
     React to a TTY.
   - `02-hooks-state-in-a-cli.md` — the `useState` triad (`turns`/`input`/`busy`) and the
     controlled-input loop.
   - `03-async-ui-with-a-busy-flag.md` — `try/catch/finally` + `busy` + `<Spinner>`, the
     loading-state triad on a local async call.
   - `04-session-as-the-data-layer.md` — `<Chat>` (display state) ↔ `session.ts` (canonical
     state); the seam between client copy and source of truth.
   - `05-jsx-to-esm-build.md` — `react-jsx` automatic runtime + `tsc` → ESM, run by Node
     with no bundler.

## Cross-links to neighboring guides

The frontend guide owns the framework-and-platform layer only. Mechanism-level topics
belong to their owning generators:

- **`study-system-design`** — server-state vs client-state ownership (the `turns` /
  Postgres split), the warm-pool + held-conversation architecture, cache-as-architecture.
- **`study-software-design`** — module depth and interface design of `ChatSession`
  (`ask`/`close`) and where `<Chat>` would grow components.
- **`study-runtime-systems`** — the event loop that suspends `await session.ask()`, raw-mode
  stdin scheduling, and the missing cancellation on an in-flight turn.
- **`study-networking`** — the wire under `session.ask()`: the pg protocol and the Ollama
  HTTP calls.
- **`study-performance-engineering`** — there is no bundle and the tree is tiny; FCP/LCP/
  bundle-size measurement has nothing to measure here yet.
- **`study-security`** — `DATABASE_URL`/secrets in `.env`, trust boundaries. No XSS/CSP
  surface (no browser).

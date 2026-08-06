# Study — Frontend Engineering (buffr-laptop)

Your React knowledge, applied to a terminal. The frontend surface here is not a browser — it's an **interactive CLI (OpenTUI)**, React-in-the-terminal. Same hooks, same component model, same reconciliation discipline you've shipped for seven years; a different paint target (the terminal grid) and a different input platform (raw-mode TTY stdin). This guide reads that one surface honestly: what's exercised, what's `not yet exercised`, and which patterns carry weight.

The whole frontend is still one component (`<Chat>` in `src/cli/chat.tsx`, now 474 lines — grown from a single request/response loop into two interactive multi-turn flows plus a live streaming progress panel) sitting on top of a data layer (`createChatSession` in `src/session.ts`). One component, more state and more machinery behind it than the file count suggests. So this guide stays dense — no padding, no inventing patterns to fill a checklist.

## Reading order

```
  start here
      │
      ▼
  00-overview.md      one page: the rendering mode, the state graph,
      │               the data seam, the five load-bearing patterns
      ▼
  audit.md            Pass 1 — the 8-lens frontend audit.
      │               What's exercised, what isn't, with file:line.
      ▼
  01..07              Pass 2 — the patterns this repo actually runs.
                      Each a full concept file (zoom out → how it
                      works → interview defense).
```

## Pass 2 — the discovered patterns

| file | pattern | what it is in industry terms |
|------|---------|------------------------------|
| `01-react-without-the-dom.md` | the reconciler (OpenTUI) | virtual-DOM reconciliation that paints to a terminal instead of the browser DOM |
| `02-hooks-state-in-a-cli.md` | local component state | `turns`/`busy`/`activeFlow`/`status`/`liveTokens`/`progressSteps` — the entire state graph, classified by lifecycle |
| `03-async-ui-with-a-busy-flag.md` | the loading state (`busy` flag) | the loading/success/error machine around an awaited call, now guarding nine call sites |
| `04-session-as-the-data-layer.md` | the container/presentational seam (`session.ts` ↔ `<Chat>`) | server-state acquisition pushed behind a façade the component just calls |
| `05-controlled-text-input.md` | controlled input (superseded, archived) | the original Ink-era controlled `<TextInput>` model — kept for history, no longer live code |
| `05-uncontrolled-input-with-submit.md` | uncontrolled multiline input | OpenTUI `<textarea ref>` + `useKeyboard` intercept — the current input model |
| `06-multi-step-flow-as-state-machine.md` | finite state machine driving a multi-turn UI | `/research`/`/review`'s predict→reveal→promote and per-item review loops, as closure-held FSMs `<Chat>` only routes input to |
| `07-streaming-progress-panel.md` | streaming progress indicator | a typed `ProgressEvent` union reduced live into a per-step checklist, frozen onto the finished turn |

## Cross-links to neighboring guides

This guide owns the **framework-and-platform layer only**. The mechanism-level teaching lives next door:

- **`study-runtime-systems`** — the event loop, the microtask queue, and how `await session.ask()` yields without blocking the render. The frontend guide says *when* `busy` flips; the runtime guide says *how* the loop schedules the resumption.
- **`study-system-design`** — where state and data live at the system level: the warm pg pool, the single long-lived conversation, the local-SQLite-canonical / cloud-mirror story. `04-session-as-the-data-layer` cross-links here.
- **`study-software-design`** — module depth and interface design behind the `ChatSession` façade. The container/presentational seam is a deep-module argument; that vocabulary is owned there.
- **`study-networking`** — the wire under `session.ask()` (Ollama HTTP, Postgres protocol). The frontend guide stops at the seam; the bytes belong there.
- **`study-performance-engineering`** — render counts, reconciliation cost, and the keystroke-re-render question as *measured numbers*. The frontend guide names the risk; performance owns the measurement.
- **`study-security`** — trust boundaries on the input. The CLI takes free-text stdin and forwards it to an agent; injection lives there, not here.

## How to use this guide

You don't need the on-ramp. You know what a hook is, what controlled input means, what reconciliation buys you. The value here is the **translation**: every browser instinct you have, mapped onto where it does and doesn't hold when React's paint target is a terminal. Read `00-overview.md`, then go straight to whichever pattern file names something you'd have to defend in an interview.

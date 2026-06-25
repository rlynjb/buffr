# Study — Frontend Engineering (buffr-laptop)

This is your home turf, so this guide skips the on-ramp. No explanation of what
a component is, what `useState` does, or why you need a key on a list. You know
that. The thing this guide does is take your React knowledge and point it at a
surface you've probably never shipped to before: **the terminal.**

`buffr-laptop` is a Node RAG agent, and the entire frontend surface is one file —
`src/cli/chat.tsx`, an **Ink** app. Ink is React, with a different reconciler.
Instead of painting a virtual DOM into the browser's DOM, it paints React
components into the terminal as text, repainting on every state change. Every
React instinct you have transfers; what changes is the *host* — there's no DOM,
no CSS, no browser, no network in the render path. The platform API is a raw-mode
TTY reading stdin one keypress at a time.

So the frame for this whole guide: **your React, applied to a terminal.**

## Reading order

```
  00-overview.md   ← read this first. One page: what the UI is,
                     the state graph, the data seam, the top patterns.

  audit.md         ← the 8-lens sweep. What's exercised, what's
                     "not yet exercised" (most of the browser lenses are).

  then the pattern files, in any order:

  01-react-without-the-dom.md       the Ink reconciler — React, new host
  02-the-session-as-the-data-layer.md   chat.tsx ↔ session.ts seam
  03-hooks-state-in-a-cli.md        useState for turns / input / busy
  04-async-ui-with-a-busy-flag.md   the spinner during the agent await
  05-controlled-text-input.md       the controlled input + onSubmit
```

## What this guide does NOT cover (and who owns it)

The partition is sharp. This guide owns the framework-and-platform layer only.
Mechanism-level teaching lives with the neighbor that owns it:

- **`study-system-design`** — where state and data live at the system level
  (the pg pool, the long-lived conversation, canonical-local storage). The
  `session.ts` data layer is described here as a *frontend seam*; its
  architecture is system-design's.
- **`study-software-design`** — module depth and interface design. The
  `ChatSession` type is a two-method interface hiding a seven-dependency
  build; that *depth* is software-design's lens.
- **`study-runtime-systems`** — the event loop, the `await` suspension, the
  raw-mode TTY read loop, top-level `await` at module load. This guide names
  where the async seam *sits in the UI*; the execution model is runtime's.
- **`study-networking`** — the Ollama HTTP calls and the pg wire protocol. The
  UI never touches the wire directly; `session.ask()` does.
- **`study-performance-engineering`** — render cost as numbers (how many
  repaints per keystroke, reconciler diff cost). This guide flags the
  *behavior*; the measurement is performance's.
- **`study-security`** — trust boundaries. Not a browser, so no XSS/CSP, but
  the terminal escape-sequence surface is security's if it ever matters.

## The honest calibration

This is a terminal React UI, not a browser app. Five of the eight frontend
lenses come back **`not yet exercised`** — routing, styling-as-CSS, data-fetch
over HTTP from the client, the browser platform, the bundler/deploy artifact.
The guide says so plainly rather than inventing patterns to fill the inventory.
What's left is the real core of frontend engineering with the browser stripped
away: **rendering, state, components, event/input handling, async data flow,
build.** Those are exercised, and they're where the five pattern files live.

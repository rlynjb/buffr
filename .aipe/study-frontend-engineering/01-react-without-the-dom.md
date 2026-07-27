# React without the DOM — the reconciler (Ink)

**Industry name(s):** virtual-DOM reconciliation with a custom host renderer · react-reconciler · "React renderer." **Type:** Industry-standard pattern (React's renderer-agnostic core), project-specific host (OpenTUI → terminal).

---

## Zoom out, then zoom in

Here's the whole frontend, and the one box that surprises people. You've shipped React-on-the-DOM for seven years. This is the same React — same elements, same hooks, same diff — with the bottom plug swapped. Instead of react-dom committing to the browser DOM, **OpenTUI** commits to the terminal grid.

```
  Zoom out — where the reconciler sits

  ┌─ Your code (React elements) ─────────────────────┐
  │  <box><text>…</text><input/></box>               │
  └───────────────────────────┬──────────────────────┘
                              │  elements
  ┌─ React core (host-agnostic) ──▼──────────────────┐
  │  ★ THE RECONCILER ★  build tree · diff · schedule │ ← we are here
  └───────────────────────────┬──────────────────────┘
                              │  mutations (create/update/remove)
  ┌─ Host renderer ───────────▼──────────────────────┐
  │  react-dom → DOM nodes  │  OpenTUI → terminal cells│ ← buffr uses OpenTUI
  └───────────────────────────┬──────────────────────┘
                              │  paint
  ┌─ Paint target ────────────▼──────────────────────┐
  │  browser viewport       │  TTY grid (Zig/bun:ffi) │
  └──────────────────────────────────────────────────┘
```

**Zoom in:** the concept is **renderer-agnostic React**. React's core builds an element tree and diffs old-vs-new; it does not know or care what a "node" is. A *host renderer* (a `react-reconciler` host config) defines what create/update/remove mean for its target. react-dom says "a node is a DOM element." OpenTUI says "a node is a box of text laid out with flexbox and printed to the terminal via a Zig native core." Buffr calls `createRoot(renderer).render(<Chat/>)` from `@opentui/react` (`src/cli/chat.tsx:72`) — that one import choice picks the terminal host. Everything above it is React you already know.

---

## The structure pass

Three layers, and we trace **one axis: "who decides what a node *is*?"** down through them. That axis flips exactly once, and the seam where it flips is the whole lesson.

```
  One axis — "who decides what a node IS?" — traced down

  ┌─ your components ─────────────┐
  │  you write <box>, <text>      │   → YOU decide the element type
  └───────────────┬───────────────┘
  ┌─ reconciler ──▼───────────────┐
  │  diffs elements, calls host   │   → REACT decides WHEN to change
  └───────────────┬───────────────┘
        ══════════╪══════════  ◄── seam: the host config
  ┌─ host renderer ▼──────────────┐
  │  OpenTUI: "node = terminal cells (Zig)" │   → THE HOST decides what a node IS
  └───────────────────────────────┘
```

- **Layers:** your components → React reconciler → host renderer → paint target.
- **Axis traced (control over node meaning):** *you* choose element types; *React* chooses when to mutate; *the host* chooses what mutation means physically.
- **The seam:** the **host config boundary**. Above it, identical to browser React. Below it, terminal-specific. This is why your reconciliation knowledge transfers verbatim and only the bottom layer is new. A finding "re-renders on turns" lives *above* the seam (React's behavior); a finding "layout is computed by OpenTUI's Zig native core, not the browser engine" lives *below* it.

Hand off to mechanics with that seam named.

---

## How it works

### Move 1 — the mental model

You know how a `fetch()` returns the same Promise whether it hits a CDN or an origin — the caller's code doesn't change, only the thing on the other end does? React's reconciler is that, for rendering. The reconciler is the caller; the host renderer is the swappable other end. Same diff algorithm, different "what happens when a node changes."

```
  Pattern — diff once, commit through whichever host is plugged in

   render() ──► [ build new element tree ]
                          │
                          ▼
                [ diff vs previous tree ]   ← reconciler (identical everywhere)
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        react-dom host           OpenTUI host      ← only THIS layer differs
        createInstance =         createInstance =
          document.createElement   a flex box + text (Zig core)
        commit = DOM mutation      commit = redraw stdout frame
```

The strategy in one sentence: **React diffs in the abstract; a host config translates the diff into physical mutations for one specific target.**

### Move 2 — the walkthrough

#### The two lines that pick the host

Everything terminal-specific flows from two imports and two calls. In a browser app this would be `import { createRoot } from 'react-dom/client'` then `createRoot(el).render(<App/>)`.

```tsx
// src/cli/chat.tsx:1-4,69-79
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from '@opentui/core';   // ← the Zig native renderer
import { createRoot } from '@opentui/react';          // ← OpenTUI IS the host renderer
// ...
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<Chat session={session} onExit={…} />);  // ← mounts on terminal
```

`createRoot` here is OpenTUI's, not react-dom's. It stands up a `react-reconciler` instance whose host config maps React mutations to terminal redraws via a Zig native core (loaded over `bun:ffi` — which is why the chat command must run under Bun). Bridge from what you know: identical role to `createRoot(domNode).render(<App/>)` — pick a root, hand it a tree. The *only* difference is the root is a terminal renderer, not a DOM node.

#### `<box>` and `<text>` are not `<div>` and `<span>`

```tsx
// src/cli/chat.tsx:46–65
<box flexDirection="column">
  <box marginBottom={1}>
    <text fg="#888888">buffr chat — …</text>
  </box>
  {turns.map((t, i) => (
    <box key={i} flexDirection="column" marginBottom={1}>
      <text attributes={TextAttributes.BOLD} fg={t.role === 'you' ? '#00FFFF' : '#00FF00'}>{t.role}</text>
      <text>{t.text}</text>
    </box>
  ))}
```

Line by line, what the host does with each:
- `<box flexDirection="column">` — OpenTUI computes a flex layout box via its Zig native core. There is no browser layout engine here; the Zig renderer does the column stacking and `marginBottom` spacing, then prints rows of text at computed positions.
- `<text>` — a run of styled characters. `fg="#00FFFF"` becomes an ANSI color escape written to stdout, not CSS. Bold is `attributes={TextAttributes.BOLD}` (imported from `@opentui/core`), not a `bold` prop.
- `key={i}` (`chat.tsx:51`) — **identical** to browser React. The reconciler uses keys to match old children to new across renders so it doesn't tear down and rebuild the whole list. Your instinct to key a `.map()` is correct here for exactly the same reason. (Index keys are fine *here* specifically because `turns` is append-only — items never reorder or get removed.)

#### The commit phase paints a frame, not nodes

When `setTurns` appends an item, the reconciler diffs and finds one new `<box>` subtree. In react-dom the commit would be `parent.appendChild(newNode)`. In OpenTUI, the commit calls through `bun:ffi` into the Zig rendering core which **redraws the terminal** — writing only the changed lines to stdout. So the visible repaint granularity is "lines of the terminal frame," not "DOM nodes." When `busy` flips, the conditional at `chat.tsx:56` swaps the input subtree for the spinner subtree — the reconciler unmounts one and mounts the other, exactly as a browser ternary would. This also clears the text field: the uncontrolled `<input>` is fresh-mounted with an empty state each time `busy` goes back to `false`.

### Move 3 — the principle

A framework's reconciler and its renderer are **separable layers**, and that separation is what lets the same component model target the DOM, native (React Native), a canvas, a PDF, or a terminal. When you learn "React," most of what you learn is the host-agnostic half — elements, hooks, diffing, keys, commit phases. The renderer is a thin, swappable adapter. Recognizing that split is why moving from react-dom to OpenTUI costs you one import swap and a vocabulary change (`<div>`→`<box>`), not a relearn.

---

## Primary diagram

The full path, one frame: your JSX → reconciler diff → Ink host config → Yoga layout → stdout frame.

```
  buffr's render path — element to terminal cell

  ┌─ UI layer (your code) ──────────────────────────────────┐
  │  <Chat>: <box>/<text>/<input>/<Spinner>                 │
  │  (src/cli/chat.tsx:45–66)                               │
  └───────────────────────────┬─────────────────────────────┘
                  setState →   │ build + diff element tree
  ┌─ React reconciler (host-agnostic) ▼─────────────────────┐
  │  matches by key · computes minimal mutation set         │
  └───────────────────────────┬─────────────────────────────┘
                  mutations →  │ host config (@opentui/react)
  ┌─ OpenTUI host renderer ────▼─────────────────────────────┐
  │  flex layout · fg/bg → ANSI · Zig native core (bun:ffi)  │
  └───────────────────────────┬─────────────────────────────┘
                  changed lines│
  ┌─ Paint target ─────────────▼─────────────────────────────┐
  │  TTY grid via stdout  (process.stdout)                   │
  └──────────────────────────────────────────────────────────┘
```

---

## Elaborate

The pattern comes from React's 2017 split into `react` (the element/component model) and `react-reconciler` (the diffing core you can plug a host into). OpenTUI is one host; React Native, react-three-fiber, react-pdf, and `react-blessed` are others. The lineage matters for your pivot: the thing you're truly expert in — component composition, hook-driven state, reconciliation behavior — is the host-agnostic core, and it carries to every one of those targets. What *doesn't* carry is layout-engine and platform specifics: OpenTUI's Zig-native flex layout here, the DOM's box model in the browser, native views in RN.

What to read next: `02-hooks-state-in-a-cli.md` (the state that drives these re-renders) and `05-uncontrolled-input-with-submit.md` (how OpenTUI's submit-only input integrates). The event-loop scheduling of re-renders during an `await` is `study-runtime-systems`; the *cost* of re-rendering the transcript is `study-performance-engineering`.

---

## Interview defense

**Q: "This is a CLI. Why is React even involved — isn't that overkill?"**

It's the same value proposition as on the web: declarative UI over imperative redraws. Without React you'd hand-manage cursor position and re-print lines on every state change. With OpenTUI, you describe the UI as a function of state (`turns`/`busy`) and the reconciler computes the minimal terminal redraw.

```
  imperative TTY            vs       React + OpenTUI
  ──────────────                     ────────────────
  console.log on each turn           UI = f(state)
  manual cursor math                 reconciler diffs the frame
  redraw bugs                        keyed list, declarative
```

Anchor: *"OpenTUI is a `react-reconciler` host — same React, the DOM swapped for a Zig terminal renderer (`createRoot` from `@opentui/react`, chat.tsx:72). Runs under Bun because OpenTUI uses `bun:ffi` to load its Zig core."*

**Q: "Does virtual-DOM diffing even buy anything when you're just printing text?"**

Yes — OpenTUI writes only changed lines, so an append doesn't re-print the whole transcript to stdout. The reconciler also preserves component state across renders via keys, so the spinner keeps its frame while turns append above it. The load-bearing part people forget: **the host config is the whole seam.** Name that you could swap OpenTUI for react-dom and `<Chat>`'s logic wouldn't change — that's the signal you understand reconciler/renderer separation, not just "React renders stuff."

```
  the seam people forget to name
  reconciler  │  host config  │  paint
   (shared)   │  (swappable)  │  (target)
```

---

## See also

- `00-overview.md` — the rendering mode in one sentence
- `02-hooks-state-in-a-cli.md` — the state that triggers these reconciles
- `05-uncontrolled-input-with-submit.md` — OpenTUI's submit-only input model
- `audit.md` lens 1 (rendering-and-reactivity)
- cross-link: `study-runtime-systems` (when the reconcile is scheduled, Bun/JSC runtime for chat), `study-performance-engineering` (what it costs)

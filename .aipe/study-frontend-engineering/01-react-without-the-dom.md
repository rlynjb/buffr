# React without the DOM — the reconciler (Ink)

**Industry name(s):** virtual-DOM reconciliation with a custom host renderer · react-reconciler · "React renderer." **Type:** Industry-standard pattern (React's renderer-agnostic core), project-specific host (Ink → terminal).

---

## Zoom out, then zoom in

Here's the whole frontend, and the one box that surprises people. You've shipped React-on-the-DOM for seven years. This is the same React — same elements, same hooks, same diff — with the bottom plug swapped. Instead of react-dom committing to the browser DOM, **Ink** commits to the terminal grid.

```
  Zoom out — where the reconciler sits

  ┌─ Your code (React elements) ─────────────────────┐
  │  <Box><Text>…</Text><TextInput/></Box>           │
  └───────────────────────────┬──────────────────────┘
                              │  elements
  ┌─ React core (host-agnostic) ──▼──────────────────┐
  │  ★ THE RECONCILER ★  build tree · diff · schedule │ ← we are here
  └───────────────────────────┬──────────────────────┘
                              │  mutations (create/update/remove)
  ┌─ Host renderer ───────────▼──────────────────────┐
  │  react-dom → DOM nodes    │  Ink → terminal cells │ ← buffr uses Ink
  └───────────────────────────┬──────────────────────┘
                              │  paint
  ┌─ Paint target ────────────▼──────────────────────┐
  │  browser viewport         │  TTY grid (stdout)    │
  └──────────────────────────────────────────────────┘
```

**Zoom in:** the concept is **renderer-agnostic React**. React's core builds an element tree and diffs old-vs-new; it does not know or care what a "node" is. A *host renderer* (a `react-reconciler` host config) defines what create/update/remove mean for its target. react-dom says "a node is a DOM element." Ink says "a node is a box of text laid out with Yoga flexbox and printed to stdout." Buffr calls `render(<Chat/>)` from Ink (`src/cli/chat.tsx:63`) — that one import choice picks the terminal host. Everything above it is React you already know.

---

## The structure pass

Three layers, and we trace **one axis: "who decides what a node *is*?"** down through them. That axis flips exactly once, and the seam where it flips is the whole lesson.

```
  One axis — "who decides what a node IS?" — traced down

  ┌─ your components ─────────────┐
  │  you write <Box>, <Text>      │   → YOU decide the element type
  └───────────────┬───────────────┘
  ┌─ reconciler ──▼───────────────┐
  │  diffs elements, calls host   │   → REACT decides WHEN to change
  └───────────────┬───────────────┘
        ══════════╪══════════  ◄── seam: the host config
  ┌─ host renderer ▼──────────────┐
  │  Ink: "node = terminal cells" │   → THE HOST decides what a node IS
  └───────────────────────────────┘
```

- **Layers:** your components → React reconciler → host renderer → paint target.
- **Axis traced (control over node meaning):** *you* choose element types; *React* chooses when to mutate; *the host* chooses what mutation means physically.
- **The seam:** the **host config boundary**. Above it, identical to browser React. Below it, terminal-specific. This is why your reconciliation knowledge transfers verbatim and only the bottom layer is new. A finding "re-renders on every keystroke" lives *above* the seam (React's behavior); a finding "flexbox is computed by Yoga, not the browser engine" lives *below* it.

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
        react-dom host           Ink host          ← only THIS layer differs
        createInstance =         createInstance =
          document.createElement   a Yoga box + text
        commit = DOM mutation      commit = redraw stdout frame
```

The strategy in one sentence: **React diffs in the abstract; a host config translates the diff into physical mutations for one specific target.**

### Move 2 — the walkthrough

#### The single line that picks the host

Everything terminal-specific flows from one import and one call. In a browser app this line would be `import { createRoot } from 'react-dom/client'`.

```tsx
// src/cli/chat.tsx:2,63
import { render, Box, Text, useApp } from 'ink';   // ← Ink IS the host renderer
// ...
render(<Chat session={session} />);                // ← mounts onto the terminal, not the DOM
```

`render` here is Ink's, not react-dom's. It stands up a `react-reconciler` instance whose host config maps React mutations to terminal redraws. Bridge from what you know: this is the exact role of `createRoot(domNode).render(<App/>)` — pick a root, hand it a tree. The *only* difference is the root is stdout, not a `<div id="root">`.

#### `<Box>` and `<Text>` are not `<div>` and `<span>`

```tsx
// src/cli/chat.tsx:38–47
<Box flexDirection="column">
  <Box marginBottom={1}>
    <Text dimColor>buffr chat — …</Text>
  </Box>
  {turns.map((t, i) => (
    <Box key={i} flexDirection="column" marginBottom={1}>
      <Text bold color={t.role === 'you' ? 'cyan' : 'green'}>{t.role}</Text>
      <Text>{t.text}</Text>
    </Box>
  ))}
```

Line by line, what the host does with each:
- `<Box flexDirection="column">` — Ink hands this to **Yoga**, Facebook's cross-platform flexbox engine, which computes a layout box. There is no browser layout engine here; Yoga does the column stacking and `marginBottom` spacing, then Ink prints rows of text at the computed positions.
- `<Text>` — a run of styled characters. `color`/`bold`/`dimColor` become ANSI escape codes written to stdout, not CSS.
- `key={i}` (`chat.tsx:43`) — **identical** to browser React. The reconciler uses keys to match old children to new across renders so it doesn't tear down and rebuild the whole list. Your instinct to key a `.map()` is correct here for exactly the same reason. (Index keys are fine *here* specifically because `turns` is append-only — items never reorder or get removed.)

#### The commit phase paints a frame, not nodes

When `setTurns` appends an item, the reconciler diffs and finds one new `<Box>` subtree. In react-dom the commit would be `parent.appendChild(newNode)`. In Ink, the commit recomputes the Yoga layout and **redraws the affected region of the terminal** — Ink diffs the output frame and writes only the changed lines to stdout. So the visible repaint granularity is "lines of the terminal frame," not "DOM nodes." The boundary condition that bites: because the *whole component* re-renders on any state change (including `setInput` per keystroke, `chat.tsx:55`), the reconciler re-evaluates the entire `turns.map()` each frame — cheap now, linear in transcript length later (see `audit.md` red flag #1). When `busy` flips, the conditional at `chat.tsx:48` swaps the input subtree for the spinner subtree — the reconciler unmounts one and mounts the other, exactly as a browser ternary would.

### Move 3 — the principle

A framework's reconciler and its renderer are **separable layers**, and that separation is what lets the same component model target the DOM, native (React Native), a canvas, a PDF, or a terminal. When you learn "React," most of what you learn is the host-agnostic half — elements, hooks, diffing, keys, commit phases. The renderer is a thin, swappable adapter. Recognizing that split is why moving from react-dom to Ink costs you one import and a vocabulary swap (`<div>`→`<Box>`), not a relearn.

---

## Primary diagram

The full path, one frame: your JSX → reconciler diff → Ink host config → Yoga layout → stdout frame.

```
  buffr's render path — element to terminal cell

  ┌─ UI layer (your code) ──────────────────────────────────┐
  │  <Chat>: <Box>/<Text>/<TextInput>/<Spinner>             │
  │  (src/cli/chat.tsx:37–58)                               │
  └───────────────────────────┬─────────────────────────────┘
                  setState →   │ build + diff element tree
  ┌─ React reconciler (host-agnostic) ▼─────────────────────┐
  │  matches by key · computes minimal mutation set         │
  └───────────────────────────┬─────────────────────────────┘
                  mutations →  │ host config (Ink)
  ┌─ Ink host renderer ────────▼─────────────────────────────┐
  │  Yoga flexbox layout · style → ANSI · frame diff         │
  └───────────────────────────┬─────────────────────────────┘
                  changed lines│
  ┌─ Paint target ─────────────▼─────────────────────────────┐
  │  TTY grid via stdout  (process.stdout)                   │
  └──────────────────────────────────────────────────────────┘
```

---

## Elaborate

The pattern comes from React's 2017 split into `react` (the element/component model) and `react-reconciler` (the diffing core you can plug a host into). Ink is one host; React Native, react-three-fiber, react-pdf, and `react-blessed` are others. The lineage matters for your pivot: the thing you're truly expert in — component composition, hook-driven state, reconciliation behavior — is the host-agnostic core, and it carries to every one of those targets. What *doesn't* carry is layout-engine and platform specifics: Yoga's flexbox subset here, the DOM's box model in the browser, native views in RN.

What to read next: `02-hooks-state-in-a-cli.md` (the state that drives these re-renders) and `05-controlled-text-input.md` (how raw-mode stdin feeds the reconciler). The event-loop scheduling of re-renders during an `await` is `study-runtime-systems`; the *cost* of re-rendering the transcript is `study-performance-engineering`.

---

## Interview defense

**Q: "This is a CLI. Why is React even involved — isn't that overkill?"**

It's the same value proposition as on the web: declarative UI over imperative redraws. Without React you'd hand-manage cursor position and re-print lines on every state change. With Ink, you describe the UI as a function of state (`turns`/`input`/`busy`) and the reconciler computes the minimal terminal redraw.

```
  imperative TTY            vs       React + Ink
  ──────────────                     ────────────
  console.log on each turn           UI = f(state)
  manual cursor math                 reconciler diffs the frame
  redraw bugs                        keyed list, declarative
```

Anchor: *"Ink is a `react-reconciler` host — same React, the DOM swapped for stdout (`render` from `'ink'`, chat.tsx:63)."*

**Q: "Does virtual-DOM diffing even buy anything when you're just printing text?"**

Yes — Ink diffs the output frame and writes only changed lines, so an append doesn't re-print the whole transcript to stdout. The reconciler also preserves component state across renders via keys, so the input field keeps its cursor while turns append above it. The load-bearing part people forget: **the host config is the whole seam.** Name that you could swap Ink for react-dom and `<Chat>`'s logic wouldn't change — that's the signal you understand reconciler/renderer separation, not just "React renders stuff."

```
  the seam people forget to name
  reconciler  │  host config  │  paint
   (shared)   │  (swappable)  │  (target)
```

---

## See also

- `00-overview.md` — the rendering mode in one sentence
- `02-hooks-state-in-a-cli.md` — the state that triggers these reconciles
- `05-controlled-text-input.md` — raw-mode stdin as the input source
- `audit.md` lens 1 (rendering-and-reactivity), red flag #1 (keystroke re-render)
- cross-link: `study-runtime-systems` (when the reconcile is scheduled), `study-performance-engineering` (what it costs)

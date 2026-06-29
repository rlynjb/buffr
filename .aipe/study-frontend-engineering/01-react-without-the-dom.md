# react-without-the-dom

*Reconciler / host-renderer split · React custom renderer (Ink) · Industry standard*

## Zoom out, then zoom in

You have shipped React to browsers for years. Every one of those apps had two halves you
never had to think about as separate: the **reconciler** (the part that diffs your
component tree and decides what changed) and the **host renderer** (the part that takes
those changes and mutates a real output — for the browser, `react-dom`, which mutates DOM
nodes). They ship together in `react-dom`, so they feel like one thing.

Ink splits them back apart. The reconciler is the same `react` package you always use.
The host renderer is `ink` — it takes the reconciler's output and paints box-drawing
characters to stdout instead of mutating DOM nodes. That is the entire trick. Here is
where it sits:

```
  Zoom out — where the renderer swap lives

  ┌─ Your code (unchanged) ─────────────────────────────────────┐
  │  <Chat/>   src/cli/chat.tsx:9     useState, JSX, props       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  same React elements
  ┌─ Reconciler (react ^18.3.1) ──▼──────────────────────────────┐
  │  virtual-DOM diff: what changed since last render?           │ ← same as always
  └───────────────────────────────┬──────────────────────────────┘
                                  │  a list of mutations
  ┌─ Host renderer ★ THE SWAP ★ ──▼──────────────────────────────┐
  │  react-dom  →  mutate <div>, <span> in a document            │
  │  ★ ink      →  lay out <Box>/<Text> via Yoga, paint to TTY ★ │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
                                  │  bytes
  ┌─ Output ──────────────────────▼──────────────────────────────┐
  │  browser: pixels      ·      ink: stdout characters          │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is *pluggable host renderer*: React's reconciler is host-agnostic,
and the host renderer is a swappable backend that knows how to create, update, and remove
"instances" in some output medium. `react-dom` is one backend; `ink` is another;
`react-native` is a third. Your `<Chat>` component does not know or care which one is
mounted under it. That is the whole concept, and it is why everything you know about React
transfers to this file with zero translation.

## Structure pass

Before the mechanics, read the skeleton. Two layers, and we trace **one axis: who decides
what the output looks like?**

```
  One axis — "who decides the output?" — held down the stack

  ┌──────────────────────────────────────┐
  │ your component  <Chat/>  chat.tsx:9   │  → YOU decide (declarative JSX)
  └──────────────────────────────────────┘
       ┌────────────────────────────────────┐
       │ reconciler (react)                 │  → REACT decides WHAT changed
       └────────────────────────────────────┘
           ┌──────────────────────────────────┐
           │ host renderer (ink)              │  → INK decides HOW to paint it
           └──────────────────────────────────┘

  the answer flips at each layer — that contrast is the lesson
```

- **Layers:** your component → reconciler → host renderer → output medium.
- **Axis traced:** "who decides the output?" You declare *intent* (JSX). React decides
  *what diffed*. Ink decides *how to realize it* on the terminal.
- **The load-bearing seam:** between the reconciler and the host renderer. That boundary
  is a fixed contract (React's reconciler calls a renderer with `createInstance`,
  `appendChild`, `commitUpdate`, `removeChild`…). Because it is a contract, you can swap
  `react-dom` for `ink` on the underside and your component on the topside never notices.
  *This is the boundary that makes the whole pattern work* — study it before either side's
  internals.

The other seam — between your component and the reconciler — does *not* flip the axis
(you always write declarative JSX, React always diffs it). That is the seam you already
know cold from browser React, so we spend our attention on the renderer seam.

## How it works

### Move 1 — the mental model

You know how `react-dom` takes `<div className="x">hi</div>` and produces a real DOM node
with that text? Ink does the same dance with a different vocabulary: `<Text color="cyan">`
becomes a styled run of characters in a flexbox-laid-out terminal frame. The reconciler in
the middle is *identical*. The shape:

```
  The pattern — one reconciler, swappable backends

         your JSX
            │
            ▼
     ┌─────────────┐     "what changed?"
     │ reconciler  │ ─── diff old tree vs new tree
     │  (react)    │     produces a mutation list
     └──────┬──────┘
            │  createInstance / commitUpdate / removeChild
            ▼
     ┌─────────────┐         ┌─────────────┐
     │  react-dom  │   OR    │     ink     │   ← pick a backend; tree code unchanged
     │  → DOM      │         │  → stdout   │
     └─────────────┘         └─────────────┘
```

The underlying strategy: **React separates "deciding what changed" from "applying the
change," and only the second half is host-specific.** Swap the second half, keep all your
component code.

### Move 2 — the walkthrough

#### The mount — one `render()` call, top level

In the browser you call `ReactDOM.createRoot(el).render(<App/>)`. Here it is one line, and
the element it renders into is the terminal itself, not a DOM node:

```tsx
// src/cli/chat.tsx:62-63
const session = await createChatSession();   // build the data layer first (top-level await)
render(<Chat session={session} />);          // ink's render — mounts <Chat> to stdout
```

`render` here is imported from `ink` (`chat.tsx:2`), not `react-dom`. That import *is* the
backend selection. From this point on, every `setState` inside `<Chat>` triggers the
reconciler, which hands a mutation list to Ink, which repaints the terminal frame. The
boundary condition to notice: this is `await createChatSession()` at module top level
(`chat.tsx:62`) — if it rejects (DB down), the app crashes *before* mount, with no rendered
error state. That is the renderer-swap's one rough edge: there is no error boundary above
`render()` to catch a pre-mount throw.

#### The host primitives — `<Box>` and `<Text>`, not `<div>` and `<span>`

Ink gives you exactly two structural primitives, and they map cleanly onto what you know:

```tsx
// src/cli/chat.tsx:37-41
<Box flexDirection="column">          {/* <Box> ≈ a <div> with display:flex always on */}
  <Box marginBottom={1}>
    <Text dimColor>buffr chat — …</Text>   {/* <Text> ≈ a <span>; styling via props */}
  </Box>
```

`<Box>` is a flex container — Ink runs the **Yoga** layout engine (the same flexbox engine
React Native uses) to compute positions, then paints. `flexDirection`, `marginBottom`
(`chat.tsx:38-39`) are real flexbox properties, resolved to terminal rows/columns instead
of CSS pixels. `<Text>` is the only thing that may hold a string; styling is props
(`dimColor`, `bold`, `color`) because there is no stylesheet to cascade from. The boundary
condition: a bare string *must* live inside `<Text>` — Ink throws if you put raw text
directly in a `<Box>`, the same way the terminal has no concept of an unstyled text node
floating in a flex container.

#### The re-render — identical to the browser, paints a frame instead of mutating nodes

This is the part where your instincts are already correct. When `onSubmit` calls
`setBusy(true)` (`chat.tsx:26`), the reconciler re-runs `<Chat>`, diffs the new tree
against the old, and finds the footer changed from `<TextInput>` to `<Spinner>`
(`chat.tsx:48-57`). It hands Ink that diff; Ink recomputes the Yoga layout and writes the
changed region to stdout.

```
  Layers-and-hops — one setState, browser vs terminal

  ┌─ component ─┐ hop 1: setBusy(true)   ┌─ reconciler ─┐ hop 2: diff   ┌─ host ──────┐
  │ <Chat>      │ ─────────────────────► │ react        │ ────────────► │ ink         │
  │ chat.tsx:26 │                        │ re-runs Chat │  footer flips │ Yoga layout │
  └─────────────┘                        └──────────────┘  TextInput→   └──────┬──────┘
                                                            Spinner        hop 3│ paint
                                                                                ▼
                                                                         ┌─ TTY ───────┐
                                                                         │ stdout frame│
                                                                         └─────────────┘
```

The only difference from your browser apps is hop 3: instead of mutating a `<span>`, Ink
writes ANSI escape sequences to stdout. Everything left of hop 3 is the React you already
know.

### Move 3 — the principle

**A renderer is a backend, and React's reconciler is backend-agnostic by design.** Once you
see that `react-dom` is just *one* implementation of a fixed renderer contract, the whole
ecosystem opens up — `ink` (terminal), `react-native` (native views), `react-three-fiber`
(WebGL scene graph), `react-pdf` (PDF). They all reuse your component knowledge and swap
only the "apply the change" half. The transferable lesson: when you learn a new React
target, you are only ever learning a new set of host primitives and a new `render()` entry
point. The reconciler, the hooks, the diffing — those never change.

## Primary diagram

The full picture: your unchanged component on top, the shared reconciler in the middle, the
swapped Ink backend painting the terminal at the bottom.

```
  react-without-the-dom — the complete frame

  ┌─ UI layer (your code, host-agnostic) ───────────────────────┐
  │  <Chat session={session}/>          src/cli/chat.tsx:9       │
  │   JSX · useState · props — identical to a browser component  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  React elements
  ┌─ Reconciler — react ^18.3.1 ──▼──────────────────────────────┐
  │  diff prev tree vs next tree → mutation list                 │
  │  (the part that is the SAME in every React target)           │
  └───────────────────────────────┬──────────────────────────────┘
              renderer contract:   │  createInstance / commitUpdate /
              ★ load-bearing seam ★ │  appendChild / removeChild
  ┌─ Host renderer — ink ^5.0.1 ──▼──────────────────────────────┐
  │  build <Box>/<Text> instances · Yoga flexbox layout ·        │
  │  paint changed region to stdout as ANSI + box-drawing        │
  │  entry: render(<Chat/>)             src/cli/chat.tsx:63       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  bytes
  ┌─ Output ──────────────────────▼──────────────────────────────┐
  │  the terminal frame the user sees                            │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The reconciler/renderer split exists because React's authors wanted the *programming model*
(declarative components, diffing, hooks) decoupled from the *output target*. They published
`react-reconciler` as a package precisely so anyone could write a backend; Ink is one of the
most-used third-party ones. The historical pivot was React 16's "Fiber" rewrite, which made
the reconciler re-entrant and pluggable enough for this. For your purposes the takeaway is
narrow and useful: this codebase is not doing anything exotic — it is using React exactly as
designed, just pointed at a terminal. The next file, `02-hooks-state-in-a-cli.md`, drops into
the component itself and walks the `useState` triad that drives this rendering.

## Interview defense

**Q: This is a CLI. Why is React even involved — isn't that overkill for terminal output?**

```
  the alternative: hand-managed terminal state

  manual:  print line → user types → clear screen → reprint everything
           you track cursor position, diff by hand, redraw on every keystroke

  ink:     declare the tree → setState → reconciler diffs → ink repaints only the delta
```

React buys the same thing in the terminal it buys in the browser: you *declare* what the UI
should look like for a given state, and the reconciler figures out the minimal repaint. The
transcript-plus-input-plus-spinner UI (`chat.tsx:37-58`) would be fiddly cursor math by hand;
as declarative JSX it is 20 lines. The reconciler earns its place the moment the UI has more
than one mutable region. Anchor: *"Ink is React's reconciler with a stdout backend instead of
a DOM backend — same model, different host."*

**Q: What's the load-bearing piece — the part that makes the swap possible?**

The **renderer contract** between the reconciler and the host renderer (the seam in the
structure pass). React's reconciler never touches a DOM node directly; it calls
`createInstance`/`commitUpdate`/`removeChild` on whatever renderer is mounted. Ink implements
those against terminal layout. Drop that contract and you would have to fork React for every
target. Naming this — not just "Ink renders to the terminal" — is the signal that you
understand *why* the swap is even possible. Anchor: *"the reconciler is host-agnostic; the
renderer contract is the seam, and `ink` implements it for the TTY."*

## See also

- `00-overview.md` — the whole frontend surface in two diagrams.
- `02-hooks-state-in-a-cli.md` — the `useState` triad that drives these re-renders.
- `03-async-ui-with-a-busy-flag.md` — what triggers the re-render this file paints.
- `05-jsx-to-esm-build.md` — how `react-jsx` compiles the JSX this file mounts.
- Cross-link: `study-runtime-systems` — the event loop and raw-mode stdin under Ink.

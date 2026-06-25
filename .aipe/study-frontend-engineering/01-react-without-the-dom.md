# 01 — React without the DOM

**Industry name(s):** custom React reconciler / alternate host renderer
(Ink). **Type:** Industry standard (the reconciler pattern); project
exercises it via Ink.

## Zoom out, then zoom in

You've shipped React to the browser for years. The thing you never had to
think about is that "React" and "the DOM" are two separate libraries that
happen to ship together. `react` is the component model and the
reconciler — the diffing brain. `react-dom` is just *one* host that knows
how to turn the diff into `document.createElement` calls. Swap that host
and React paints somewhere else entirely. Here, the somewhere-else is the
terminal.

```
  Zoom out — where the reconciler sits in buffr-laptop

  ┌─ Terminal (the host surface) ───────────────────────────┐
  │  stdout: a grid of characters, repainted in frames       │
  └───────────────────────────────▲─────────────────────────┘
                                   │ paint (text frames)
  ┌─ Render layer ────────────────┴─────────────────────────┐
  │  ★ Ink reconciler ★   diffs the React tree,              │ ← we are here
  │  computes Yoga layout, writes characters to stdout       │
  └───────────────────────────────▲─────────────────────────┘
                                   │ React elements
  ┌─ Component layer  src/cli/chat.tsx ─────────────────────┐
  │  <Chat> → <Box>/<Text>/<TextInput>/<Spinner>            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **alternate host renderer**. Same React you know —
`useState`, JSX, reconciliation, keys, the component tree. Different host:
instead of `react-dom` writing to `document`, Ink writes to a terminal.
The question this answers: *how does a React tree become pixels when there
is no DOM to mutate?*

## Structure pass

**Layers.** Three, stacked: the component layer (`chat.tsx`, your JSX),
the reconciler layer (Ink, the diffing brain plus Yoga layout), and the
host surface (the terminal's character grid). React's component model is
identical across all React apps; only the bottom two layers differ from
what you ship to the browser.

**Axis — trace "what is a host instance?" down the stack.** This is the
one question that makes the browser-vs-terminal contrast pop:

```
  one question, held constant down the layers

  "what does a rendered element become?"

  ┌─────────────────────────────────────┐
  │ component layer:  <Text>hello</Text> │  → a React element (same everywhere)
  └─────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ reconciler (react-dom): host node    │  → an HTMLElement, appended to DOM
      └─────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ reconciler (Ink):  host node         │  → a layout box, painted as chars
      └─────────────────────────────────────┘
```

The answer flips at the reconciler: a `<Text>` becomes an `HTMLElement`
under react-dom and a Yoga layout box under Ink. That flip is the whole
lesson.

**Seam.** The load-bearing seam is the **host config** — the contract
between the reconciler and the host. `react-reconciler` calls a fixed set
of host methods (`createInstance`, `appendChild`, `commitUpdate`,
`removeChild`…); react-dom implements them against the DOM, Ink implements
them against a terminal buffer. Your component code sits entirely *above*
this seam and never sees it. That's why every React instinct transfers.

## How it works

#### Move 1 — the mental model

You know how `react-dom` takes `<div>` and produces a real DOM node? The
reconciler doesn't do that part. The reconciler does the *diff* — it walks
your element tree, compares it to the previous tree, and produces a list
of host operations: "create this node, update that one's text, remove this
one." A separate object, the **host config**, knows how to execute those
operations against a specific surface. React is the diff; the host config
is the hands.

```
  the reconciler pattern — diff brain, swappable hands

   your tree   ──►  ┌──────────────┐  ──► host ops  ──► ┌────────────┐
   <Chat/>          │  reconciler  │  create/update/    │ host config│
   (React           │  (diff brain)│  remove            │  (hands)   │
    elements)       └──────────────┘                    └─────┬──────┘
                          ▲                                    │
                          │ same brain                         ▼
                          │ for every host             react-dom → DOM
                                                        Ink       → terminal
```

#### Move 2 — the walkthrough

**The element tree is host-agnostic.** Bridge from what you know: when you
write `<Box flexDirection="column">` in `chat.tsx`, that's the same kind
of React element as `<div style={{display:'flex'}}>` in a browser app — a
plain object describing *what* to render, not *how* to paint it. `Box` and
`Text` are Ink's host components, the terminal's answer to `div` and
`span`. Nothing about the element creation knows it's headed for a
terminal. Where it breaks if you forget this: you can't use `<div>` here,
because there's no host config method that knows what a `div` is — Ink only
registers `Box`, `Text`, and a few others.

```
  Pattern — host components are the only "primitives" the host knows

  browser host:   div  span  input  ...   (react-dom knows these)
  terminal host:  Box  Text  ...          (Ink knows these)

  <Box>   ── reconciler asks host config ──► "make a layout box"
  <div>   ── reconciler asks host config ──► ✗ Ink has no method for this
```

**The reconciler diffs, exactly like react-dom.** When `setBusy(true)`
runs, React re-renders `<Chat>` and produces a new element tree. The
reconciler diffs new-vs-old and finds: the `<TextInput>` subtree is gone,
a `<Text>` with the spinner is new. It emits "remove the input box, create
the spinner text." This is the identical algorithm you rely on in the
browser — same keyed reconciliation, same bailout rules, same `key`
semantics on the `turns.map()`.

**The host config commits to the terminal.** This is the only layer that's
different from your browser work. Instead of `parent.appendChild(node)`,
Ink's host config records the change in an off-screen layout tree, runs
**Yoga** (a flexbox layout engine compiled to JS) to compute where every
box sits in character-grid coordinates, renders that to a string, and
writes it to `stdout` — erasing and repainting the changed region of the
terminal frame.

```
  Layers-and-hops — a state change crossing the three layers

  ┌─ Component  chat.tsx ─┐  hop 1: setBusy(true) → re-render
  │  <Chat> returns new   │ ──────────────────────────────────►
  │  element tree         │
  └───────────────────────┘
                            ┌─ Reconciler (Ink) ─────────────┐
              hop 2: diff   │  old tree vs new tree           │
              ───────────►  │  → [remove input, add spinner]  │
                            └──────────────┬──────────────────┘
                              hop 3: commit │ + Yoga layout
                                            ▼
                            ┌─ Host surface (terminal) ───────┐
                            │  write chars to stdout,          │
                            │  repaint changed region          │
                            └──────────────────────────────────┘
```

**Move 2 variant — the load-bearing skeleton.** Strip the renderer to its
kernel and three parts remain, each named by what breaks without it:

1. **The reconciler (diff brain).** Drop it and you have no React at all —
   you're back to manually computing what changed and calling
   `console.log`. This is `react`, the package, untouched from the browser.
2. **The host config (the hands).** Drop it and the reconciler computes a
   diff with nowhere to send it. This is the *entire* difference between
   react-dom and Ink — same brain, different hands.
3. **The commit-to-stdout step.** Drop it and the layout tree updates in
   memory but the terminal never repaints — the UI freezes while state
   keeps changing. This is Ink's "render to a string and diff the
   string against the last frame" step.

Optional hardening on top: Yoga layout (you could position by hand),
output throttling (Ink batches writes), alternate-screen-buffer handling.
The kernel is brain + hands + commit.

#### Move 3 — the principle

React is not a UI library; it's a *reconciliation* library with a default
UI host bolted on. Once you internalize that the host is swappable —
terminal (Ink), native mobile (React Native), 3D (react-three-fiber), PDF
(react-pdf) — your React knowledge stops being "browser knowledge" and
becomes "any-tree-that-changes-over-time knowledge." That's the transfer.

## Primary diagram

The whole renderer, one frame: your component code on top, the swappable
reconciler in the middle, the terminal at the bottom.

```
  React-without-the-DOM — the full picture in buffr-laptop

  ┌─ Component layer  src/cli/chat.tsx ─────────────────────────┐
  │  function Chat() {                                            │
  │    useState ...           ← same hooks as browser            │
  │    return <Box><Text/><TextInput/></Box>  ← Ink primitives   │
  │  }                                                            │
  └────────────────────────────┬─────────────────────────────────┘
                               │ React elements (host-agnostic)
  ┌─ Reconciler  react + Ink host config ──▼─────────────────────┐
  │  react:  diff old tree vs new tree → host ops                │
  │  Ink:    createInstance/appendChild/commitUpdate against a    │
  │          terminal buffer + Yoga flexbox layout                │
  └────────────────────────────┬─────────────────────────────────┘
                               │ characters + cursor moves
  ┌─ Host surface  the terminal ───────────▼─────────────────────┐
  │  stdout: repaint the changed region of the frame             │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** This pattern is reached for exactly once — at app boot —
and then it's invisible. Every state change in `<Chat>` rides it without
the component knowing. The two concrete touchpoints: the `render()` call
that hands the tree to Ink, and the JSX that uses Ink's primitives instead
of DOM elements.

```
  src/cli/chat.tsx  (lines 1-2, 62-63)

  import { useState } from 'react';                ← line 1
       │  only useState — NOT React itself, because
       │  jsx: react-jsx (tsconfig.json:13) injects the
       │  JSX runtime automatically. No `import React`.
       │
  import { render, Box, Text, useApp } from 'ink'; ← line 2
       │  render = Ink's entry point (the react-dom.render
       │  equivalent). Box/Text = the host primitives.
       │
  const session = await createChatSession();       ← line 62
  render(<Chat session={session} />);              ← line 63
       │  this single call mounts the tree into Ink's
       │  reconciler. Drop it and nothing ever paints —
       │  the component is defined but never hosted.
```

```
  src/cli/chat.tsx  (lines 37-47) — Ink primitives, not DOM

  return (
    <Box flexDirection="column">          ← line 38
         │  Box ≈ a flex <div>; Yoga lays it out as a
         │  column of stacked rows in the char grid.
      <Box marginBottom={1}>              ← line 39
        <Text dimColor>buffr chat …</Text>← line 40
             │  Text ≈ <span>; dimColor is a terminal
             │  attribute, not a CSS property.
      </Box>
      {turns.map((t, i) => (              ← line 42
        <Box key={i} …>                   ← line 43  same keyed
             │  reconciliation you use in the browser —
             │  React diffs this list by key exactly as react-dom would.
```

The JSX target is set at `tsconfig.json:13` (`"jsx": "react-jsx"`), which
is why `chat.tsx:1` can import `useState` alone — the automatic runtime
supplies the element factory. Compilation is plain `tsc`
(`package.json:7`), output run with `node dist/src/cli/chat.js`
(`package.json:12`).

## Elaborate

The reconciler-as-a-library idea comes from React 16's rewrite (Fiber),
which deliberately split the diffing engine (`react-reconciler`) from the
renderers so third parties could target new hosts. Ink, React Native,
react-three-fiber, and react-pdf are all the same move: implement the host
config, get React's component model for free. Ink specifically reuses
**Yoga** — the same flexbox engine React Native uses — which is why
`flexDirection` and `marginBottom` feel familiar even though there's no
CSS; you're driving the same layout engine, just rendering its output as
characters instead of native views.

What to read next: `03-hooks-state-in-a-cli.md` (the state that drives the
re-renders this file's reconciler diffs) and `05-controlled-text-input.md`
(the input side, where the raw-mode TTY replaces the browser's keydown).

## Interview defense

**Q: "It's a CLI — why is React even involved? Isn't that overkill?"**
Verdict first: it's the right tool the moment the UI has state that
changes over time. The transcript grows, the input updates per keystroke,
the spinner toggles — that's a reactive UI, and React's reconciler does
the "figure out the minimal repaint" work that you'd otherwise hand-roll
with cursor math. The kernel I'd name: React is a reconciliation library,
and the host is swappable — Ink is just a host config that commits to
stdout instead of the DOM.

```
   <Chat/> ──► reconciler (diff) ──► host config ──► terminal
                  same brain          swappable        repaint
                  as react-dom        hands            only the delta
```

**Q: "What's the one thing that's actually different from a browser React
app?"** The host config — the layer that turns the diff into side effects.
Above it (components, hooks, keys, reconciliation) is identical. Below it,
react-dom calls `appendChild` on real DOM nodes; Ink records layout
changes, runs Yoga, and writes characters to stdout. Anchor:
`render(<Chat/>)` at `chat.tsx:63` is the only line where "this is a
terminal app" actually shows up.

**If you don't know:** the honest recovery is "I know React splits the
reconciler from the renderer, and Ink implements the renderer half for the
terminal — I'd have to check Ink's host config to name the exact methods,
but the contract is `react-reconciler`'s host-instance interface."

## Validate

1. **Reconstruct:** draw the three layers (component / reconciler / host)
   and label what a `<Text>` element becomes in each. Name the line that
   mounts the tree (`chat.tsx:63`).
2. **Explain:** why can `chat.tsx:1` import `useState` without importing
   `React`? (Answer ties to `tsconfig.json:13`.)
3. **Apply:** if you added `<button>` to the JSX, what happens and why?
   (No host config method for it — Ink only knows `Box`/`Text`.)
4. **Defend:** someone says "rewrite this with `readline` and
   `console.log`, drop React." What specifically do you lose? (The
   reconciler's minimal-repaint diff; you'd manually track what changed
   on the screen.)

## See also

- `00-overview.md` — where this sits among the top three patterns.
- `03-hooks-state-in-a-cli.md` — the state changes this reconciler diffs.
- `05-controlled-text-input.md` — the input/platform side of the host.
- `study-runtime-systems` — the Node event loop the reconciler runs on.
- `study-performance-engineering` — repaint cost as numbers.

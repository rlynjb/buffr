# 05 — Controlled text input

**Industry name(s):** controlled component · value/onChange binding ·
single source of truth for input. **Type:** Industry standard (the
pattern); raw-mode TTY is the project-specific platform twist.

## Zoom out, then zoom in

This is the most familiar pattern in the whole guide — a controlled input.
`value={input}`, `onChange={setInput}`, `onSubmit={handler}`. You've
written it ten thousand times against `<input>`. The only thing that
changes here is the platform underneath: instead of the browser turning
keystrokes into `change` events on a DOM node, a **raw-mode TTY** turns
keypresses into `onChange` calls. The React pattern is identical; the
input device is a terminal reading stdin one byte at a time.

```
  Zoom out — where the controlled input sits in buffr-laptop

  ┌─ Platform  raw-mode TTY ────────────────────────────────┐
  │  process.stdin, byte by byte (the "keydown" source)      │
  └───────────────────────────────▼──────────────────────────┘
                                  │ keypress → onChange
  ┌─ Component  ink-text-input ───┴─────────────────────────┐
  │  ★ <TextInput value={input} onChange={setInput} ★        │ ← we are here
  │     onSubmit={onSubmit} />        chat.tsx:55             │
  └───────────────────────────────┬──────────────────────────┘
                                  │ value reflects React state
  ┌─ State  chat.tsx:12 ──────────▼──────────────────────────┐
  │  input: string   the single source of truth for the field│
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **the controlled component** — React state is the
single source of truth for the field's value, the input renders that
value, and every keystroke flows through `onChange` back into state. The
question this answers: *how does the field's text stay in sync with React
state when the input device is a terminal, not a DOM node?*

## Structure pass

**Layers.** Three: the platform (raw-mode stdin), the controlled component
(`TextInput`), and the state (`input`). The controlled-component contract
sits in the middle, identical to what you ship in the browser; only the
platform layer is unfamiliar.

**Axis — trace "where does the field's value live?" down the stack.** The
state-ownership axis is what makes "controlled" mean something:

```
  one question down the stack

  "where is the field's text the source of truth?"

  ┌─ uncontrolled (NOT this) ─┐    ┌─ controlled (this) ──────┐
  │ the input owns its text   │    │ React state owns it      │
  │ React reads it on submit  │    │ input renders state      │
  └───────────────────────────┘    │ onChange writes state    │
                                    └──────────────────────────┘
                                            ▲
                            chat.tsx:12 input is the truth;
                            chat.tsx:55 the field just reflects it
```

In a controlled input the answer is unambiguous: the value lives in React
state (`input`), and the field is a pure reflection of it. That's the
definition of "controlled," and it's why you can clear the field with
`setInput('')` from anywhere.

**Seam.** The load-bearing seam is the `value` / `onChange` pair at
`chat.tsx:55`. `value={input}` is the render-down direction (state →
field); `onChange={setInput}` is the event-up direction (field → state).
Together they close the loop that makes the field controlled.

## How it works

#### Move 1 — the mental model

You know the controlled-input loop cold: the input shows `value`, a
keystroke fires `onChange`, `onChange` updates state, the new state
re-renders the input with the new `value`. It's a cycle. The terminal
doesn't change the cycle one bit — it only changes where the keystroke
*comes from*: a raw-mode stdin read instead of a DOM `change` event.

```
  the controlled-input loop

   ┌──────────────► input shows value={input} ──────────┐
   │                                                      │
   │ re-render                                   keypress │
   │ with new value                            (raw stdin)│
   │                                                      ▼
   state: input ◄──── setInput(newValue) ◄──── onChange fires
```

#### Move 2 — the walkthrough

**`value={input}` is the render-down half.** Bridge from what you know:
this is `<input value={input}>` — the field always displays whatever's in
state. At `chat.tsx:55`, `value={input}`. The consequence you rely on:
state is the only way to change what's shown. When `onSubmit` does
`setInput('')` at `chat.tsx:24`, the field empties on the next render
*because* it's controlled — there's no separate field-internal value to
also clear. Where it breaks if uncontrolled: clearing state wouldn't clear
the field, and you'd see the old text linger.

**`onChange={setInput}` is the event-up half.** Every keypress that
`TextInput` receives produces the new full string and hands it to
`onChange`. Here `onChange` *is* `setInput` directly (`chat.tsx:55`) — the
new value goes straight into state, which re-renders the field. This is
the cycle's return path. Where it breaks without it: a controlled input
with `value` but no `onChange` is frozen — keystrokes have nowhere to go,
so the field never updates.

```
  Pattern — the two halves of the binding

   value={input}    ─── state → field ───►  field shows current text
                                                    │
   onChange={setInput} ◄── field → state ───────────┘
                          (keypress → new string → setInput → re-render)
```

**The platform twist: a raw-mode TTY supplies the keypresses.** This is
the only part that isn't browser-identical. In the browser, the OS and the
browser deliver a `keydown`/`input` event to the DOM node. Here, Ink puts
`process.stdin` into **raw mode** — no line buffering, no waiting for
Enter, no echo — and reads it byte by byte. `ink-text-input` interprets
those bytes (a printable char appends, backspace deletes, arrows move the
cursor, Enter triggers `onSubmit`) and calls `onChange` with the resulting
string. Raw mode is why you get *per-character* `onChange` instead of
per-line. Where it breaks: if stdin isn't a TTY (piped input, some CI),
raw mode isn't available and the input degrades.

```
  Layers-and-hops — a keystroke crossing the platform into state

  ┌─ Platform  TTY ─┐  hop 1: byte 'h'        ┌─ TextInput (ink) ──────┐
  │  raw-mode stdin │ ───────────────────────► │  append → value "h"     │
  │  (no line buf)  │                           │  call onChange("h")     │ hop 2
  └─────────────────┘                           └───────────┬─────────────┘
        ▲                                          hop 3: setInput("h")
        │ hop 5: re-render shows "h"                         ▼
        │                                        ┌─ State  chat.tsx:12 ───┐
        └──────────────────────────────────────  │  input = "h"            │
                       hop 4: value={input}       └─────────────────────────┘
```

**`onSubmit` fires on Enter — the line-commit.** Enter is special: raw mode
delivers it as a byte, `TextInput` recognizes it, and instead of appending
calls `onSubmit(value)` (`chat.tsx:55` → the handler at `:15`). That's the
"line is done" signal — the browser's form-submit equivalent, but for a
single line in a terminal.

**Move 2 variant — the load-bearing skeleton.** Three parts, named by what
breaks:

1. **`value={input}` (render-down).** Drop it and the field is
   uncontrolled — state no longer drives the display, and `setInput('')`
   can't clear it.
2. **`onChange={setInput}` (event-up).** Drop it and a controlled input
   freezes — keystrokes can't reach state, the field never updates.
3. **The raw-mode TTY read.** Drop it (line-buffered stdin) and you lose
   per-character `onChange` — you'd only get the string after Enter, which
   breaks live editing and the cursor.

Optional hardening: the `placeholder="ask buffr"` (`chat.tsx:55`) is a
cosmetic empty-state hint; cursor movement and backspace handling come
free from `ink-text-input`.

#### Move 3 — the principle

"Controlled" means React state is the *single source of truth* for the
input — the field is a function of state, never the other way around. The
payoff is that any code path can read or write the field by reading or
writing state: the submit handler clears it with `setInput('')`, a future
feature could pre-fill it, validation could read it. The moment the field
owns its own value (uncontrolled), all of that goes through DOM/ref
plumbing instead. The platform under the input — DOM or TTY — is
incidental; the source-of-truth discipline is the pattern.

## Primary diagram

The full controlled loop, one frame, with the raw-mode platform on top.

```
  Controlled text input — full picture

  ┌─ Platform  raw-mode TTY ────────────────────────────────────┐
  │  process.stdin, byte by byte → printable appends, Enter      │
  │  commits, backspace deletes  (the keypress source)           │
  └────────────────────────────┬─────────────────────────────────┘
                              keypress
  ┌─ Component  chat.tsx:53-56 ▼─────────────────────────────────┐
  │  <Text color="cyan">{'> '}</Text>                            │
  │  <TextInput                                                  │
  │     value={input}        ── state → field (render-down) ──┐  │
  │     onChange={setInput}  ── field → state (event-up) ─────┼┐ │
  │     onSubmit={onSubmit}  ── Enter → commit the line ──────┼┼┐│
  │     placeholder="ask buffr" />                            │││ │
  └──────────────────────────────────────────────────────────┼┼┼─┘
                                                              │││
  ┌─ State  chat.tsx:12 ───────────────────────────────────▼▼▼─┐
  │  const [input, setInput] = useState('')   ← single source   │
  │     cleared by setInput('') in onSubmit (chat.tsx:24)        │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached for continuously while the user types a question
(per-keystroke `onChange`), and once per question on Enter (`onSubmit`).
The field only renders when `busy` is false (`chat.tsx:52-57`) — while a
turn is in flight, the spinner replaces it entirely, so there's no input
to control.

```
  src/cli/chat.tsx  (lines 53-56) — the controlled input

  <Box>
    <Text color="cyan">{'> '}</Text>            ← :54  the prompt arrow
    <TextInput
      value={input}                             ← :55  state → field (controlled)
      onChange={setInput}                       ← :55  field → state (per keystroke)
      onSubmit={onSubmit}                       ← :55  Enter → run the turn
      placeholder="ask buffr"                   ← :55  empty-state hint
    />
  </Box>
       │
       └─ value + onChange make this controlled: input (chat.tsx:12) is the single
          source of truth. onSubmit hands the Enter-committed line to the handler.
```

```
  src/cli/chat.tsx  (line 24) — clearing the field is a state write

  setInput('');
       │
       └─ because the field is CONTROLLED, emptying state empties the field on the
          next render. No ref, no DOM reset — clearing input IS clearing the field.
          Fired before the await so the field empties instantly on submit.
```

The platform layer (raw-mode stdin) is owned by `ink-text-input`
(`package.json:20`) and Ink's `useInput`/raw-mode handling — buffr's code
never touches `process.stdin` directly; it gets per-character `onChange`
for free.

## Elaborate

The controlled-component pattern is React's answer to the oldest UI
question: who owns the field's value, the widget or your code? React's
opinionated answer — your state owns it — is what makes forms predictable,
and `ink-text-input` honors that contract exactly, so your browser
instincts transfer with zero translation. The interesting seam is purely
the platform: a browser `<input>` and a terminal `TextInput` expose the
*same* `value`/`onChange`/`onSubmit` API over completely different input
hardware (DOM events vs raw-mode bytes). That's the whole "React without
the DOM" thesis (`01-react-without-the-dom.md`) made concrete at the input
layer.

The raw-mode TTY itself — line discipline, the byte-level stdin read, how
Node delivers keypresses — is `study-runtime-systems`' (I/O) and the
platform's concern. This file owns the controlled-component contract; the
TTY is named here only as the keypress source that replaces the DOM.

## Interview defense

**Q: "Is this a controlled or uncontrolled input, and how do you know?"**
Verdict: controlled. The proof is two-fold — `value={input}` ties the
display to state, and `onChange={setInput}` routes every keystroke back
into state (`chat.tsx:55`). The tell that clinches it: the submit handler
clears the field with `setInput('')` (`chat.tsx:24`), which only works
because state is the source of truth.

```
   value={input} ──► field shows state
   onChange={setInput} ──► keystroke → state
   setInput('') ──► clears field   (controlled hallmark)
```

**Q: "What's actually different from a browser `<input>`?"** Only the
platform under it. The browser delivers `keydown` events from a DOM node;
here Ink reads a raw-mode TTY byte by byte and `ink-text-input` turns
those bytes into the same `onChange` calls. The `value`/`onChange`/
`onSubmit` contract is identical. The load-bearing twist: raw mode is what
gives per-character `onChange` instead of per-line.

**If you don't know:** "I know it's controlled — `value` and `onChange`
both bind to `input` state — and the keypresses come from a raw-mode TTY
instead of the DOM. I'd check `ink-text-input`'s internals to name exactly
how it reads stdin, but the React contract is the standard controlled
input."

## Validate

1. **Reconstruct:** draw the controlled loop. Name the two props that make
   it controlled and the line they're on (`chat.tsx:55`).
2. **Explain:** why does `setInput('')` at `chat.tsx:24` clear the visible
   field? What would happen if the input were uncontrolled?
3. **Apply:** you want to pre-fill the field with the last question on
   up-arrow. Where does that value go, and why is controlled-input what
   makes it easy?
4. **Defend:** someone asks why you get `onChange` per keystroke instead
   of once on Enter. Tie the answer to raw mode vs line-buffered stdin.

## See also

- `00-overview.md` — where this sits among the patterns.
- `03-hooks-state-in-a-cli.md` — `input` as one of the three state slices.
- `01-react-without-the-dom.md` — the same DOM-swap thesis, at the input.
- `04-async-ui-with-a-busy-flag.md` — why the input vanishes during a turn.
- `study-runtime-systems` — the raw-mode stdin read at the I/O level.

# Controlled text input — value owned by React, over raw-mode stdin

**Industry name(s):** controlled component · controlled input · single-source-of-truth input. **Type:** Industry-standard pattern (controlled vs uncontrolled), project-specific platform: raw-mode TTY stdin instead of a DOM input.

---

## Zoom out, then zoom in

The text field where you type your question is a **controlled input** — React owns the value, not the widget. Same pattern you've written a thousand times for `<input>`, here over a different platform: the terminal in raw mode, reading keystrokes char-by-char. Here's where it sits and why the platform swap doesn't change the pattern.

```
  Zoom out — controlled input over the TTY, not the DOM

  ┌─ Platform (input source) ────────────────────────────┐
  │  raw-mode stdin (TTY) — keystrokes, char by char      │ ← the platform
  └───────────────────────────┬──────────────────────────┘
                  key events   │
  ┌─ Widget (ink-text-input) ─▼──────────────────────────┐
  │  <TextInput value onChange onSubmit>                  │
  └───────────────────────────┬──────────────────────────┘
        value ▲   onChange │   onSubmit │
  ┌─ UI state (React) ─────┴───────────▼──────────────────┐
  │  ★ input: string ★  React owns the value (chat.tsx:12)│ ← we are here
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is the **controlled component** — the widget renders whatever value React hands it and reports every change back up, so React state is the single source of truth for the field. Buffr's field is `<TextInput value={input} onChange={setInput} onSubmit={onSubmit}>` (`src/cli/chat.tsx:55`). The only thing that differs from a browser `<input>` is what's underneath: instead of the DOM's keydown stream, it's the terminal in raw mode. The pattern is identical; the platform is new.

---

## The structure pass

One axis: **"who holds the current text?"** Trace it from platform up to React. In an *un*controlled input the widget holds it; in a *controlled* one React does. That flip is the whole definition, and the seam is where it happens.

```
  Axis — "who holds the current text?" — platform → React

  ┌─ raw stdin ───────────┐   → holds nothing (just emits keys)
  └───────────┬───────────┘
  ┌─ TextInput ▼──────────┐   → holds nothing (renders the prop)
  └───────────┬───────────┘
        ══════╪══════  ◄── seam: value/onChange contract
  ┌─ React state ▼────────┐   → HOLDS the text (input string)
  └───────────────────────┘
```

- **Layers:** raw stdin (emits keys) → `<TextInput>` widget (renders + reports) → React state (owns).
- **Axis (ownership of the value):** the platform and the widget hold nothing; React's `input` string is the sole holder. The value flows *down* (prop) and changes flow *up* (callback) — the controlled-component loop.
- **The seam:** the `value`/`onChange` pair (`chat.tsx:55`). Above it the widget is a pure function of the prop; below it React decides what the value is. This is exactly the seam you know from the DOM — `ink-text-input` just sits on raw-mode stdin instead of a DOM node. Platform/trust details of raw-mode input belong to `study-runtime-systems` (the TTY) and `study-security` (free-text forwarded to an agent).

---

## How it works

### Move 1 — the mental model

You know the controlled-input loop cold: `value={x}` renders the field, `onChange` writes the new value back to state, state re-renders the field. It's a one-way data flow with the widget as a dumb mirror. Same loop here — picture it as a cycle that closes through React every keystroke.

```
  Pattern — the controlled loop (value down, change up)

        ┌──────────── value={input} ─────────────┐
        ▼                                         │
   ┌──────────┐  keystroke  ┌───────────┐         │
   │ TextInput│ ──onChange─►│ setInput  │ ──► input string
   └──────────┘             └───────────┘         │
        ▲                                         │
        └────────── re-render with new value ─────┘
              Enter ──onSubmit──► onSubmit(value)
```

The strategy in one sentence: **the widget never stores the text — it renders the prop and reports every change, so React state is the single source of truth, and Enter hands that truth to a submit handler.**

### Move 2 — the walkthrough

#### Value down — React feeds the field

```tsx
// src/cli/chat.tsx:12, 55
const [input, setInput] = useState('');
// ...
<TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="ask buffr" />
```

`value={input}` makes the field a mirror of React state. Bridge from the browser: this is `<input value={input} …>` verbatim. The widget displays exactly what `input` holds — if React says the string is `"hel"`, that's what's on screen, cursor and all. The widget has no independent memory of the text.

#### Change up — every keystroke writes back

`onChange={setInput}` is the up-channel. `ink-text-input` reads raw-mode stdin char-by-char and, on each keypress, computes the new string and calls `onChange(newValue)`. Note the convenience: it hands you the **string directly**, not a synthetic event — so `onChange={setInput}` works as a bare reference (no `e => setX(e.target.value)` unwrap). Each call triggers `setInput`, which re-renders, which feeds the new `value` back down. That's the loop closing. Boundary condition: this is also *why* the transcript re-renders on every keystroke — `setInput` updates `<Chat>` state, and the `turns.map()` is in the same component (`audit.md` red flag #1). The fix is to push the input into a child so this loop closes below the transcript.

#### Clearing — only possible because it's controlled

```tsx
// src/cli/chat.tsx:24
setInput('');   // clear the field after submit
```

Because React owns the value, clearing the field is just `setInput('')` — the next render shows an empty field. With an *uncontrolled* input you couldn't do this without reaching into the widget imperatively. This single line is the clearest proof the field is controlled: state-drives-view means resetting state resets the view.

#### Submit — Enter hands the value to the handler

```tsx
// src/cli/chat.tsx:15, 55
const onSubmit = async (value: string): Promise<void> => { … };
// ...
<TextInput … onSubmit={onSubmit} />
```

`ink-text-input` watches raw stdin for the Enter key and, when it fires, calls `onSubmit(currentValue)`. Bridge: same role as a form's `onSubmit` / an input's Enter `onKeyDown`. The handler receives the value (`chat.tsx:15`), trims it, runs the guard, and kicks off the turn (see `03-async-ui-with-a-busy-flag.md`). The field is unmounted entirely while `busy` (the ternary at `chat.tsx:48`), so there's nothing to type into mid-turn — the controlled value persists in `input` state across that unmount/remount because state lives on `<Chat>`, not on the torn-down widget.

### Move 2 variant — the load-bearing skeleton

The irreducible core: **`value` prop (down) + `onChange` callback (up) + state as the single source of truth.** Named by what breaks:

- Drop **`value={input}`** → the field becomes uncontrolled; the widget holds its own text and `setInput('')` can no longer clear it (`chat.tsx:24` stops working).
- Drop **`onChange`** → the value never flows back to React; `input` stays `''` forever and the field appears frozen (you'd see keystrokes only if the widget kept internal state, i.e. uncontrolled).
- Drop **single-source-of-truth** (let both the widget and React hold text) → they drift; the displayed text and `input` disagree, and submit sends the wrong string.

Optional hardening *not* present: no input validation, no max length, no IME/multiline handling, no debounce on `onChange`. The skeleton is just the controlled loop; everything else is layered on.

### Move 3 — the principle

Controlled vs uncontrolled is a question of **where the source of truth lives**, and the controlled answer — React owns it — is what makes the value programmable: you can clear it, prefill it, validate it, transform it, all by setting state. That principle is platform-independent: it's identical for a DOM `<input>`, a React Native `<TextInput>`, and Ink's `<TextInput>` on raw-mode stdin. The platform changes what emits the keystrokes; the pattern that decides who owns the resulting value does not.

---

## Primary diagram

The full controlled loop, from the TTY up through React and back, plus the submit branch.

```
  buffr's controlled input — the complete loop

  ┌─ Platform: raw-mode stdin (TTY) ────────────────────────┐
  │  keystroke 'h' · 'e' · 'l' · … · Enter                  │
  └───────────────────────────┬──────────────────────────────┘
                  key events   │
  ┌─ Widget: <TextInput> (ink-text-input, chat.tsx:55) ─────▼┐
  │  renders value={input}  ──onChange(newStr)──┐            │
  │                          ──onSubmit(value)──┼──► onSubmit │ (chat.tsx:15)
  └───────────────────────────┬─────────────────┘            │
        value ▲ (down)        │ onChange (up)                │
  ┌─ React state ─────────────▼──────────────────────────────┐
  │  input: string  ── setInput ──► re-render ── value ──┐    │
  │  setInput('') clears the field (chat.tsx:24)         │    │
  └──────────────────────────────────────────────────────┘    │
                                                               ▼
                                          submit → trim → guard → ask()
```

---

## Elaborate

Controlled components are React's answer to "the DOM holds form state by default, which forks your source of truth." By binding `value` and `onChange`, you pull the value into React so it's part of the same state graph as everything else — diffable, resettable, derivable. `ink-text-input` reimplements the exact contract over the terminal, which is the clean demonstration that the pattern is about ownership, not the DOM. Two things this field deliberately doesn't do: validate the input, and treat it as untrusted — the trimmed string goes straight to `session.ask()` and into an LLM prompt, so the trust boundary (free text → agent) is real and lives in `study-security`.

Read next: `03-async-ui-with-a-busy-flag.md` (what `onSubmit` triggers) and `02-hooks-state-in-a-cli.md` (`input` among the state triad). The raw-mode TTY mechanics are `study-runtime-systems`; the untrusted-input boundary is `study-security`.

---

## Interview defense

**Q: "Is this a controlled or uncontrolled input, and how do you know?"**

Controlled — `value={input}` is bound to React state and `onChange={setInput}` reports every keystroke back, so React is the single source of truth. The proof: `setInput('')` clears the field after submit (`chat.tsx:24`). You can only do that imperative-free reset when React owns the value.

```
  controlled vs uncontrolled — the tell
  uncontrolled: widget holds text → can't clear from state
  controlled:   value={x} + onChange → setInput('') clears it  ← buffr
```

Anchor: *"value down, change up, React owns the truth — same contract as a DOM input, over raw-mode stdin (chat.tsx:55)."*

**Q: "This is a terminal — does the controlled pattern even apply?"**

Fully. `ink-text-input` reimplements the `value`/`onChange`/`onSubmit` contract over raw-mode stdin; the platform that emits keystrokes changed, the ownership pattern didn't. The load-bearing insight: controlled-vs-uncontrolled is about *where the source of truth lives*, which is platform-independent — DOM, React Native, and Ink all express the same loop.

```
  same pattern, three platforms
  DOM <input> │ RN <TextInput> │ Ink <TextInput>
  all = value down · change up · React owns the value
```

---

## See also

- `03-async-ui-with-a-busy-flag.md` — what `onSubmit` kicks off
- `02-hooks-state-in-a-cli.md` — `input` within the state triad
- `01-react-without-the-dom.md` — how the field reconciles to the terminal
- `audit.md` lens 7 (browser-platform-and-build), red flag #1 (keystroke re-render)
- cross-link: `study-runtime-systems` (raw-mode TTY), `study-security` (untrusted free-text input)

# Uncontrolled input with submit — OpenTUI's submit-only input model

**Industry name(s):** uncontrolled component · uncontrolled input · ref-managed input. **Type:** Industry-standard pattern (uncontrolled vs controlled), project-specific platform: OpenTUI terminal input instead of DOM `<input>`.

---

## Zoom out, then zoom in

The text field where you type your question is an **uncontrolled input** — the widget holds the value internally, React never owns it. That's the opposite of the browser controlled-input pattern you've used for years. Here's where it sits and why the platform swap flips the ownership model.

```
  Zoom out — uncontrolled input over the terminal

  ┌─ Platform (input source) ────────────────────────────┐
  │  raw-mode TTY — keystrokes, char by char              │ ← the platform
  └───────────────────────────┬──────────────────────────┘
                  key events   │
  ┌─ Widget (<input>, OpenTUI) ▼──────────────────────────┐
  │  holds the text internally · clears on unmount        │
  │  fires onSubmit(value: string) on Enter               │ ← buffr uses this
  └───────────────────────────┬──────────────────────────┘
       only submit  │   (no value/onChange handshake)
  ┌─ UI state (React) ─────────▼──────────────────────────┐
  │  ★ React never holds the text ★                       │ ← we are here
  │  onSubmit receives value once, at Enter               │
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is the **uncontrolled component** — the widget manages its own text, and React only learns the final value at submit. Buffr's field is `<input placeholder="ask buffr" onSubmit={onSubmit as any} focused />` (`src/cli/chat.tsx:62`). No `value` prop. No `onChange`. The field clears automatically when `busy` unmounts it (ternary at `chat.tsx:56`) and remounts fresh when `busy` becomes `false`. React gets exactly one notification per turn: `onSubmit(value)` on Enter.

---

## The structure pass

One axis: **"who holds the current text?"** In a *controlled* input React holds it; in an *uncontrolled* one the widget holds it. That flip is the whole definition.

```
  Axis — "who holds the current text?" — platform → React

  ┌─ raw TTY stdin ────────┐   → holds nothing (just emits keys)
  └───────────┬────────────┘
  ┌─ <input> widget ▼──────┐   → HOLDS the text (internal widget state)
  │  (uncontrolled)        │      ← seam: only onSubmit crosses out
  └───────────┬────────────┘
  ┌─ React state ▼─────────┐   → holds NOTHING (turns + busy only)
  └────────────────────────┘
```

- **Layers:** raw stdin (emits keys) → `<input>` widget (holds + clears) → React (receives only on submit).
- **Axis (ownership):** the widget is the sole holder. React receives a one-time notification. There is no per-keystroke loop.
- **The seam:** `onSubmit(value: string)` at `chat.tsx:62`. Above it the widget is opaque; below it React processes the trimmed value, appends a `you` turn, fires `ask()`, etc.

---

## How it works

### Move 1 — the mental model

You know the uncontrolled-input pattern from refs: `<input ref={inputRef} />` — you read `inputRef.current.value` only when you need it, rather than syncing every keystroke to state. OpenTUI's `<input>` is the terminal equivalent: no `value`/`onChange` contract at all. The widget owns the buffer; you get the final string at Enter. Clearing is free: unmounting the widget discards its internal state, and remounting gives you a fresh empty field.

```
  Controlled vs uncontrolled — the contrast

  Controlled (DOM / was Ink)        Uncontrolled (OpenTUI)
  ──────────────────────────        ──────────────────────
  value={x} → widget renders x      widget holds own text
  onChange → setX per keystroke      no onChange callback
  setX('') to clear on submit        unmount to clear (automatic)
  React re-renders per keystroke     React notified at submit only
```

The strategy in one sentence: **the widget is a black box that emits one event — the trimmed value at Enter — and React handles it then.**

### Move 2 — the walkthrough

#### The field declaration

```tsx
// src/cli/chat.tsx:59–62
<box>
  <text fg="#00FFFF">{'> '}</text>
  <input placeholder="ask buffr" onSubmit={onSubmit as any} focused />
</box>
```

Three attributes, no `value`, no `onChange`:

- `placeholder="ask buffr"` — displayed when the widget is empty.
- `onSubmit={onSubmit as any}` — fires with the current string when Enter is pressed. The `as any` cast is a TypeScript workaround: `@opentui/react` declares `onSubmit` as an intersection type `((event: SubmitEvent) => void) & ((value: string) => void)` that no single function can satisfy without a cast. At runtime, OpenTUI calls it with the string value — the cast is safe.
- `focused` — tells OpenTUI this widget should receive keyboard focus immediately on mount.

#### Submit — Enter hands the value to the handler

```tsx
// src/cli/chat.tsx:24–43
const onSubmit = (value: string): void => {
  const q = value.trim();
  if (busy || !q) return;
  if (q === '/exit' || q === '/quit') {
    onExit().catch(err => { console.error(err); process.exit(1); });
    return;
  }
  setTurns(t => [...t, { role: 'you', text: q }]);
  setBusy(true);
  session.ask(q).then(
    answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
    err => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
  );
};
```

`onSubmit` receives `value` — the full string the user typed. Trim, guard, dispatch. React appends the `you` turn, sets `busy` to `true`. The ternary at `chat.tsx:56` immediately unmounts this `<input>` and mounts `<Spinner />`. When the answer arrives, `busy` goes to `false`, the spinner unmounts, and a **fresh `<input>`** mounts — empty, focused, ready.

#### Clearing — handled by unmount/remount

The old controlled pattern cleared the field with `setInput('')`. Here there is no `input` state to clear. When `busy` becomes `true`, React unmounts the `<input>` entirely — its internal text buffer is garbage-collected. When `busy` returns to `false`, React mounts a new `<input>` starting empty. This is the uncontrolled analogue of clearing: throw the old widget away and start fresh.

```
  clearing — controlled vs uncontrolled

  Controlled (old Ink):  setInput('') → React owns empty string → re-render
  Uncontrolled (OpenTUI): setBusy(true) → widget unmounts → widget remounts fresh
```

### Move 2 variant — the load-bearing skeleton

The irreducible core: **`<input onSubmit focused />` (no value/onChange) + `busy` ternary that unmounts/remounts it + handler that receives value at Enter.**

- Drop **`onSubmit`** → React never learns what the user typed.
- Drop **`focused`** → the widget doesn't receive keystrokes (nothing to submit).
- Drop **the `busy` ternary unmount** → the field stays mounted during the turn; OpenTUI may still send keystrokes but `if (busy) return` guards against them; the field's text buffer isn't cleared, so the next turn starts with leftover text.
- Add **`value` prop** → TypeScript error; OpenTUI's `<input>` has no `value` prop — it's deliberately uncontrolled.

### Move 3 — the principle

Controlled vs uncontrolled is a question of **where the source of truth lives**. Controlled means React owns it — programmable (clear, prefill, validate) at the cost of a per-keystroke loop. Uncontrolled means the widget owns it — zero per-keystroke overhead, but you can only inspect the value at a trigger point (submit, blur). For a terminal chat where the only action is "submit on Enter" and clearing is free via remount, uncontrolled is the right fit. The principle is platform-independent; the right answer flips by use case, not by platform.

---

## Primary diagram

The full uncontrolled loop, from TTY up through OpenTUI's widget and back to React on submit.

```
  buffr's uncontrolled input — the complete flow

  ┌─ Platform: raw-mode TTY ─────────────────────────────────┐
  │  keystroke 'h' · 'e' · 'l' · … (buffered in widget)      │
  └───────────────────────────┬──────────────────────────────┘
                  key events   │
  ┌─ Widget: <input> (OpenTUI, chat.tsx:62) ─────────────────▼┐
  │  holds text internally · widget state, not React state    │
  │  on Enter ── onSubmit(value: string) ──────────────────►  │
  └───────────────────────────┬──────────────────────────────┘
    unmount when busy=true     │
    remount when busy=false    │ onSubmit fires once per Enter
    (clears buffer for free)   │
  ┌─ React (chat.tsx:24) ─────▼──────────────────────────────┐
  │  trim → guard → append you turn → setBusy(true)          │
  │  → widget unmounts → Spinner mounts                      │
  │  → ask() resolves → setBusy(false)                       │
  │  → Spinner unmounts → fresh <input> mounts               │
  └──────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the paradigm flip from what buffr used before. Previously, Ink's `<TextInput>` was controlled: `value={input}`, `onChange={setInput}`, `setInput('')` on submit — React owned every keystroke. OpenTUI's `<input>` makes the opposite choice: it holds its own buffer, fires once on Enter, clears on unmount. The practical effect is that the `input` state hook is gone entirely — two `useState` hooks instead of three, and the state architecture is simpler. The uncontrolled model is a natural fit for submit-only fields; it would be less natural if you needed to programmatically set or inspect the in-progress text mid-turn, which buffr doesn't.

Read next: `03-async-ui-with-a-busy-flag.md` (what `onSubmit` triggers and the full busy lifecycle) and `02-hooks-state-in-a-cli.md` (why input isn't a hook here). The raw-mode TTY mechanics are `study-runtime-systems`; the trust boundary (free text → agent) is `study-security`.

---

## Interview defense

**Q: "Is this a controlled or uncontrolled input, and how do you know?"**

Uncontrolled — there's no `value` prop and no `onChange`. OpenTUI's `<input>` holds its own text internally and fires `onSubmit(value)` on Enter. The proof: there's no `input` state in `<Chat>` at all — you can't clear it with `setX('')` because React doesn't own it. Clearing happens automatically when `busy` unmounts the widget.

```
  uncontrolled — the tells
  no value= prop                → widget owns the text
  no onChange= callback         → no per-keystroke React update
  no input useState             → nothing to clear imperatively
  clearing = unmount + remount  → React's lifecycle does it
```

Anchor: *"No value prop, no onChange, no input state hook. The widget fires once — on Enter — and clears on unmount (chat.tsx:62). That's textbook uncontrolled."*

**Q: "How does the field clear between turns if React doesn't own the value?"**

`setBusy(true)` triggers the ternary at `chat.tsx:56` which unmounts the `<input>` and mounts `<Spinner />`. The widget's internal text buffer is gone. When the answer arrives and `busy` goes back to `false`, a fresh `<input>` mounts — empty, focused. React's unmount/remount lifecycle is the clear mechanism; no explicit reset needed.

```
  clearing without state ownership
  busy=true  → <input> unmounts → buffer discarded
  busy=false → <input> remounts → starts empty, focused
  (same effect as setInput(''), zero per-keystroke cost)
```

---

## See also

- `03-async-ui-with-a-busy-flag.md` — what onSubmit kicks off and the busy lifecycle
- `02-hooks-state-in-a-cli.md` — why input is not a useState hook
- `01-react-without-the-dom.md` — how the field reconciles to the terminal via OpenTUI
- `audit.md` lens 7 (browser-platform-and-build), lens 3 (component-architecture)
- cross-link: `study-runtime-systems` (raw-mode TTY, Bun runtime), `study-security` (untrusted free-text input)

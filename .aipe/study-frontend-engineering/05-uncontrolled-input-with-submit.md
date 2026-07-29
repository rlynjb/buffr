# Uncontrolled multiline textarea with keyboard intercept — OpenTUI's ref-API input model

**Industry name(s):** uncontrolled component · uncontrolled input · ref-managed input · keyboard intercept. **Type:** Industry-standard pattern (uncontrolled vs controlled), project-specific: OpenTUI `<textarea ref>` + `useKeyboard` hook over a terminal TTY.

---

## Zoom out, then zoom in

The text field where you type your question is an **uncontrolled input** — the widget holds the value internally, React never owns it. The new implementation (2026-07) replaced a single-line `<input onSubmit>` with a **multiline `<textarea ref={taRef}>`** plus a **`useKeyboard` interceptor** that distinguishes Enter (submit) from Alt+Enter (new line). That split is the entire behaviour change; the uncontrolled ownership model is the same.

```
  Zoom out — uncontrolled textarea over the terminal

  ┌─ Platform (input source) ────────────────────────────┐
  │  raw-mode TTY — keystrokes, char by char              │ ← the platform
  └───────────────────────────┬──────────────────────────┘
                  key events   │
  ┌─ useKeyboard hook ─────────▼──────────────────────────┐
  │  intercepts all keys BEFORE widget default handling   │
  │  Enter (no modifier) → handleSubmit()                 │
  │  Alt+Enter (e.meta)  → taRef.current.newLine()        │ ← buffr uses this
  └───────────────────────────┬──────────────────────────┘
  ┌─ <textarea ref={taRef}> (OpenTUI) ──────────────────▼─┐
  │  holds text internally · multiline buffer             │
  │  taRef.current.plainText  → reads the text            │
  │  taRef.current.setText('') → clears on submit         │
  │  taRef.current.newLine()  → inserts \n                │
  └───────────────────────────┬──────────────────────────┘
       only submit  │   (no value/onChange handshake)
  ┌─ UI state (React) ─────────▼──────────────────────────┐
  │  ★ React never holds the text ★                       │
  │  handleSubmit reads .plainText once, then .setText('') │
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is the **uncontrolled component** — the widget manages its own text, and React only reads it at submit. `<textarea ref={taRef}>` holds the buffer. `useKeyboard` intercepts the key that would trigger submit. The ref API (`plainText`, `setText`, `newLine`) is the only surface React uses. No `value` prop. No `onChange`. No `input` useState.

---

## The structure pass

One axis: **"who holds the current text?"** Controlled = React; uncontrolled = the widget.

```
  Axis — "who holds the current text?" — platform → React

  ┌─ raw TTY stdin ────────┐   → holds nothing (just emits keys)
  └───────────┬────────────┘
  ┌─ useKeyboard ──────────▼───┐ → intercepts before widget sees Enter
  └───────────┬───────────────┘
  ┌─ <textarea> widget ────▼───┐ → HOLDS the text (internal buffer)
  │  ref-API: plainText / setText / newLine
  └───────────┬───────────────┘
  ┌─ React state ──────────▼───┐ → holds NOTHING about the text
  │  turns + busy + status + liveTokens only
  └────────────────────────────┘
```

The seam: `taRef.current.plainText` at submit time. Above the seam the widget is opaque; below it React processes the trimmed value, appends a `you` turn, fires `ask()`.

---

## How it works

### Move 1 — the mental model

You know the uncontrolled-input pattern from refs: `<input ref={inputRef} />` — you read `inputRef.current.value` only at submit rather than syncing every keystroke to state. OpenTUI's `<textarea>` is the terminal equivalent, with a ref-API surface instead of a DOM node:

```
  Controlled (DOM browser)         Uncontrolled (OpenTUI textarea)
  ───────────────────────          ──────────────────────────────
  value={x} → widget renders x      widget holds own buffer
  onChange → setX per keystroke      no onChange callback
  setX('') to clear on submit        taRef.current.setText('') to clear
  React re-renders per keystroke     React reads once, at submit
```

The key difference from the old `<input onSubmit>` model: **the widget doesn't fire an event on Enter**. Instead, `useKeyboard` fires first and calls `handleSubmit()` manually. The `<textarea>` never sees the Enter key (it's `e.preventDefault()`'d). That separation is what enables the Alt+Enter split — `useKeyboard` routes the modifier, preventing Enter from inserting a literal newline.

### Move 2 — the walkthrough

#### The keyboard interceptor

```tsx
// src/cli/chat.tsx — useKeyboard hook
useKeyboard((e: any) => {
  if (e.name !== 'return' && e.name !== 'kpenter') return;  // only intercept Enter
  if (e.ctrl || e.super || e.hyper) return;                  // pass through Ctrl/Super
  if (busy) return;                                          // locked during a turn
  e.preventDefault();                                        // block widget default
  if (e.meta) {
    taRef.current?.newLine();   // Alt+Enter → insert newline in textarea
  } else {
    handleSubmit();             // bare Enter → submit
  }
});
```

`useKeyboard` runs before the textarea's own key handler. `e.preventDefault()` stops the key from reaching the widget — so Enter never inserts a literal newline; only `newLine()` does (via `e.meta`).

#### The field declaration

```tsx
// src/cli/chat.tsx — the input area
<box border={true} borderStyle="rounded" borderColor="#444444"
     paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
  <textarea
    ref={taRef}
    placeholder="type your message… (Alt+Enter for new line)"
    textColor="#CCCCCC"
    placeholderColor="#555555"
    onSubmit={handleSubmit}
    focused
  />
</box>
```

No `value` prop. No `onChange`. `ref={taRef}` is the only React hook into the widget. `onSubmit` is present as an OpenTUI fallback but the keyboard interceptor normally fires first.

#### Submit — reading and clearing via the ref

```tsx
// src/cli/chat.tsx — handleSubmit
const handleSubmit = (): void => {
  const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
  if (busy || !q) return;
  taRef.current?.setText('');          // clear the widget buffer
  if (q === '/exit' || q === '/quit') {
    onExit().catch(err => { console.error(err); process.exit(1); });
    return;
  }
  setTurns(t => [...t, { role: 'you', text: q }]);
  setBusy(true);
  setStatus('thinking…');
  setLiveTokens({ input: 0, output: 0 });
  // ... session.ask() with callbacks
};
```

`taRef.current.plainText` reads the current text. `setText('')` clears it imperatively after reading. This is the ref-API equivalent of `setInput('')` in a controlled model — but React still holds no text state.

### Move 3 — the principle

Uncontrolled inputs minimize re-renders by keeping the text buffer outside React. The tradeoff: you can't declaratively set, validate, or observe the text mid-turn. For a submit-only chat field where the only operation on the buffer is "read at submit + clear," that tradeoff is correct. The `useKeyboard` separation is the price of multiline — you give up the widget's built-in submit event, get full control of the Enter key in exchange.

---

## Primary diagram

```
  buffr's uncontrolled textarea — the complete flow

  ┌─ Platform: raw-mode TTY ──────────────────────────────────┐
  │  keystrokes 'h' 'e' 'l' 'l' 'o' '\n' (alt+enter) …      │
  └──────────────────────────┬────────────────────────────────┘
  ┌─ useKeyboard hook ────────▼────────────────────────────────┐
  │  on bare Enter → e.preventDefault() → handleSubmit()      │
  │  on Alt+Enter  → e.preventDefault() → taRef.newLine()     │
  │  other keys    → pass through to textarea                  │
  └──────────────────────────┬────────────────────────────────┘
  ┌─ <textarea ref={taRef}> ──▼────────────────────────────────┐
  │  buffer: "hello\nworld"  (holds text, React doesn't)      │
  │  .plainText → "hello\nworld"   (read at submit)           │
  │  .setText('')              (cleared after read)           │
  │  .newLine()                (inserts \n on Alt+Enter)      │
  └──────────────────────────┬────────────────────────────────┘
  ┌─ React (handleSubmit) ────▼────────────────────────────────┐
  │  trim → guard → setText('') → append 'you' turn           │
  │  setBusy(true) → session.ask() resolves → setBusy(false)  │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The shift from `<input onSubmit>` to `<textarea ref>` + `useKeyboard` was motivated by multiline support. The old `<input>` fired `onSubmit` on Enter automatically; the new `<textarea>` doesn't, so `useKeyboard` intercepts the key first. The result: Enter submits, Alt+Enter inserts a newline, any other modifier passes through. The uncontrolled ownership model is unchanged — React still holds no text state. The ref API (`plainText`, `setText`, `newLine`) is not typed by `@opentui/react`; both `taRef` and `startRef` (inside `<Spinner>`) use `useRef<any>` with an eslint suppression, which means future OpenTUI renames are not caught by the compiler.

Read next: `03-async-ui-with-a-busy-flag.md` (what `handleSubmit` kicks off and the full busy lifecycle) and `02-hooks-state-in-a-cli.md` (why input isn't a useState hook here). Raw-mode TTY mechanics belong to `study-runtime-systems`; the trust boundary (free text → agent) belongs to `study-security`.

---

## Interview defense

**Q: "Is this a controlled or uncontrolled input, and how do you know?"**

Uncontrolled — no `value` prop, no `onChange`. `<textarea ref={taRef}>` holds its own buffer. React reads `.plainText` once at submit and clears with `.setText('')`. There is no `input` useState anywhere in `<Chat>`.

```
  uncontrolled tells
  no value= prop              → widget owns the buffer
  no onChange= callback       → no per-keystroke React update
  no input useState           → nothing for React to hold
  setText('') via ref         → imperative clear, not state update
```

**Q: "How does Alt+Enter insert a newline instead of submitting?"**

`useKeyboard` intercepts all Enter keys before the textarea sees them. It calls `e.preventDefault()` to block the widget's default handling, then checks `e.meta` (true when Alt/Option is held). Alt+Enter calls `taRef.current.newLine()` to insert a literal newline into the buffer; bare Enter calls `handleSubmit()`. The textarea never processes the Enter key itself.

---

## See also

- `03-async-ui-with-a-busy-flag.md` — what handleSubmit kicks off and the busy lifecycle
- `02-hooks-state-in-a-cli.md` — why input is not a useState hook
- `01-react-without-the-dom.md` — how the field reconciles to the terminal via OpenTUI
- `audit.md` lens 7 (browser-platform-and-build), lens 3 (component-architecture)
- `05-controlled-text-input.md` — the superseded Ink era controlled model (archive)
- cross-link: `study-runtime-systems` (raw-mode TTY, Bun runtime), `study-security` (untrusted free-text input)

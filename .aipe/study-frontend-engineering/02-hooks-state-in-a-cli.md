# hooks-state-in-a-cli

*The `useState` triad + controlled input · React local state · Industry standard*

## Zoom out, then zoom in

This is the most home-turf file in the guide. `<Chat>` holds three `useState` hooks and a
controlled text input — you have written this exact shape a thousand times in a browser
form. The only thing to recalibrate is that the input is a terminal `<TextInput>`, not an
`<input>`, and the "form" is a chat loop. Everything else is the React you already own.

```
  Zoom out — where the state lives in the whole surface

  ┌─ UI layer (terminal) ───────────────────────────────────────┐
  │  <Chat>  src/cli/chat.tsx:9                                  │
  │   ┌───────────────────────────────────────────────────────┐ │
  │   │ ★ THREE useState HOOKS ★                               │ │ ← we are here
  │   │   turns  Turn[]   :11   input  string  :12  busy  :13  │ │
  │   └───────────────────────────────────────────────────────┘ │
  │   <TextInput value={input} onChange={setInput} … >  :55     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  session.ask(q)
  ┌─ Data layer ──────────────────▼──────────────────────────────┐
  │  ChatSession  src/session.ts                                 │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Two patterns share this file because they are inseparable here: the **state
triad** (three independent `useState` slices, one per concern) and the **controlled input**
(the input's value lives in state, not in the widget). The question both answer: *where
does the truth about "what's on screen right now" live?* Answer: in `<Chat>`'s hooks, and
nowhere else.

## Structure pass

Three state slices, one axis: **who owns each transition, and when does it fire?**

```
  One axis — "who flips this state, and when?" — across the three slices

  ┌─ input  string ───────────────────────────────────────┐
  │  owner: <TextInput> onChange      when: every keystroke│  → fast, per-key
  └───────────────────────────────────────────────────────┘
  ┌─ turns  Turn[] ───────────────────────────────────────┐
  │  owner: onSubmit                  when: submit + answer│  → append-only
  └───────────────────────────────────────────────────────┘
  ┌─ busy   boolean ──────────────────────────────────────┐
  │  owner: onSubmit try/finally      when: around ask()   │  → brackets the await
  └───────────────────────────────────────────────────────┘

  three slices, three different transition owners — that's why they're three hooks
```

- **Layers:** the widget (`<TextInput>`) → the handler (`onSubmit`) → the render output.
- **Axis:** "who owns the transition?" `input` is owned by the widget's `onChange` and
  fires per keystroke. `turns` is owned by `onSubmit` and only appends. `busy` is owned by
  `onSubmit`'s `try/finally` and brackets the async call.
- **The seam that matters:** `input` flips on a *different clock* than `turns`/`busy`.
  `input` changes on every key; `turns`/`busy` change once per submitted question. Splitting
  them into separate hooks means a keystroke re-renders without touching the transcript, and
  a submit doesn't fight the keystroke clock. That clock-split is *why this is three hooks
  and not one state object* — the load-bearing reason.

## How it works

### Move 1 — the mental model

The state triad is the same instinct you use when you decide a form needs `email`,
`password`, and `submitting` as three separate `useState`s rather than one
`useState({email, password, submitting})`: **one slice per independent concern, so a
change to one doesn't force you to spread the other two.** The shape:

```
  The pattern — one hook per independent concern

   ┌───────────────────────────────────────────────┐
   │  concern              state slice              │
   ├───────────────────────────────────────────────┤
   │  "what's typed"   →   input  : string          │  changes per keystroke
   │  "what's said"    →   turns  : Turn[]          │  changes per turn
   │  "is it working"  →   busy   : boolean         │  changes per request
   └───────────────────────────────────────────────┘
       each slice has its own setter; updating one
       leaves the other two untouched
```

The controlled input is the other half: `<TextInput>`'s displayed value *is* `input`
state, and the only way it changes is by calling `setInput`. The widget never holds its own
truth — React does. Same contract as a controlled `<input value={x} onChange={…}>`.

### Move 2 — the walkthrough

#### The three hooks — declared once at the top, typed

```tsx
// src/cli/chat.tsx:11-13
const [turns, setTurns] = useState<Turn[]>([]);   // transcript, starts empty
const [input, setInput] = useState('');           // controlled buffer, starts ''
const [busy, setBusy]   = useState(false);         // in-flight flag, starts false
```

`Turn` is `{ role: 'you' | 'buffr'; text: string }` (`chat.tsx:7`) — a discriminated union
on `role`, which is what drives the color choice later (`chat.tsx:44`). Three hooks, three
initial values, three setters. Nothing here is terminal-specific; paste it into a browser
component and it compiles unchanged. The boundary condition: because these are independent
hooks, a stale-closure bug in one (reading an old `turns` inside an async callback) wouldn't
corrupt `busy` — but `onSubmit` sidesteps that risk entirely by using the *functional*
setter form, covered next.

#### The functional updater — append without reading stale state

Every transcript append uses `setTurns(t => [...t, …])`, never `setTurns([...turns, …])`:

```tsx
// src/cli/chat.tsx:25  (on submit)
setTurns((t) => [...t, { role: 'you', text: q }]);
// src/cli/chat.tsx:29  (on answer, AFTER an await)
setTurns((t) => [...t, { role: 'buffr', text: answer }]);
```

This is the bug you have caught in code review a hundred times: line 29 runs *after*
`await session.ask(q)` (`chat.tsx:28`), so the `turns` variable captured in the closure is
stale — it is whatever `turns` was when `onSubmit` started, missing the `'you'` turn that
line 25 just added. The functional updater `(t) => …` receives the *latest* committed
state, not the closed-over one, so the `'buffr'` turn appends onto the real current array.
**This is the single most load-bearing line-level decision in the component.** Drop the
functional form and use `setTurns([...turns, …])` on line 29 and the user's question would
vanish from the transcript the moment the answer arrives.

```
  Execution trace — why the functional updater is required

  onSubmit starts:   turns = []           (closure captures this [])
  line 25 setTurns:  turns → [you:q]      (functional, fine either way)
  ── await ask() ──  (turns commits to [you:q], but closure var still [])
  line 29 options:
    stale [...turns]:   [] + buffr  = [buffr]        ✗ lost the question
    functional (t=>):   [you:q] + buffr = [you:q, buffr]  ✓ correct
```

#### The controlled input — value in state, cleared by hand

```tsx
// src/cli/chat.tsx:55
<TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="ask buffr" />
```

`value={input}` + `onChange={setInput}` is the controlled-component contract: the widget
shows what state says, and every keystroke routes through `setInput` to update state, which
re-renders the widget with the new value. Because state is the source of truth, clearing the
field is just `setInput('')` (`chat.tsx:24`) — done immediately on submit, *before* the
await, so the field empties the instant you hit enter rather than after the model responds.
The boundary condition you know: if you forgot `value={input}` and only kept `onChange`, the
input would be *uncontrolled* and `setInput('')` wouldn't clear it — the widget would hold
its own buffer. Same trap as a browser `<input>`.

#### The render reads state, switches on `busy`

```tsx
// src/cli/chat.tsx:42-57
{turns.map((t, i) => (                                  // turns drives the transcript
  <Box key={i} flexDirection="column" marginBottom={1}>
    <Text bold color={t.role === 'you' ? 'cyan' : 'green'}>{t.role}</Text>
    <Text>{t.text}</Text>
  </Box>
))}
{busy ? (<Text…><Spinner/> thinking…</Text>)          // busy switches footer
      : (<Box>…<TextInput value={input} …/></Box>)}    // input feeds the field
```

All three slices feed the render: `turns` is mapped (`chat.tsx:42`), `busy` picks the footer
(`chat.tsx:48`), `input` is the field's value (`chat.tsx:55`). The `key={i}` on line 43 is
the array index — *safe here* because `turns` is strictly append-only and never reordered or
removed, but it is exactly the pattern that breaks if anyone ever splices the array. (Flagged
in `audit.md` red-flag 2.)

### Move 3 — the principle

**Split state by transition clock, not by data shape.** `input` changes per keystroke;
`turns` and `busy` change per request. Bundling them into one object would couple the fast
clock to the slow one and invite stale-closure bugs across concerns. The functional updater
is the partner rule: any setter that runs after an `await` must take the latest state as an
argument, never close over it. Both rules are framework-agnostic — they hold in Vue's
`ref`s, in a `useReducer`, in any reactive system where a transition can outlive the closure
that scheduled it.

## Primary diagram

The full state-and-render loop in one frame.

```
  hooks-state-in-a-cli — the complete loop

  ┌─ <Chat> state (src/cli/chat.tsx) ───────────────────────────┐
  │   turns Turn[] :11      input string :12      busy bool :13  │
  └───┬───────────────────────┬───────────────────────┬─────────┘
      │ map :42               │ value :55             │ switch :48
      ▼                       ▼                       ▼
  ┌─ render ─────────────────────────────────────────────────────┐
  │  transcript rows   ·   <TextInput> | <Spinner>   (footer)     │
  └──────────────────────────────────────────────────────────────┘
                              │ keystroke → onChange=setInput :55
                              │ enter     → onSubmit          :55
                              ▼
  ┌─ onSubmit  src/cli/chat.tsx:15 ──────────────────────────────┐
  │  setInput('') :24                                            │
  │  setTurns(t=>[…you]) :25     setBusy(true) :26               │
  │  await session.ask(q) :28                                    │
  │  setTurns(t=>[…buffr]) :29   (functional → latest state)     │
  │  setBusy(false) :33  (finally)                               │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

`useState` is the reducer primitive in disguise — `useState` is `useReducer` with a trivial
"replace" reducer. The functional-updater form (`setTurns(t => …)`) is the seam where that
shows: you are handing React a reducer function `(prev) => next`, and React applies it
against the latest committed state. This component never needs `useReducer` proper because
the three slices don't share a transition; the moment two of them had to change atomically
together (say, "set busy *and* clear an error in one commit"), promoting to `useReducer`
would be the move. For now, three `useState`s is the honest minimum. Next:
`03-async-ui-with-a-busy-flag.md` walks the `try/finally` that drives `busy`.

## Interview defense

**Q: Why three separate `useState`s instead of one state object?**

```
  one object                          three slices
  ──────────                          ────────────
  setState({...s, input: v})          setInput(v)
  every change spreads all three      each change touches one
  input keystroke re-creates the      input keystroke leaves turns/busy
  whole object                        objects untouched
```

Because the three change on different clocks — `input` per keystroke, `turns`/`busy` per
request — and bundling them couples the fast clock to the slow one and forces a spread on
every keystroke. Separate hooks keep each transition independent and sidestep a whole class
of stale-spread bugs. Anchor: *"split state by transition frequency, not by data shape."*

**Q: There's an `await` between two `setTurns` calls. What's the trap, and how does the code
avoid it?**

The trap is the stale closure: the second `setTurns` (`chat.tsx:29`) runs after the await,
so a `[...turns, …]` form would read the `turns` value from *before* the user's turn was
added and silently drop it. The code uses the functional updater `setTurns(t => [...t, …])`
so React passes the latest committed array, not the closed-over one. Naming this — that the
post-await setter must take state as an argument — is the signal you have debugged this for
real. Anchor: *"any setter after an await uses the functional form, because the closure's
copy is stale."*

## See also

- `01-react-without-the-dom.md` — what repaints when these setters fire.
- `03-async-ui-with-a-busy-flag.md` — the `try/finally` that owns the `busy` slice.
- `04-session-as-the-data-layer.md` — where `turns` (display) and the DB (canonical) split.
- Cross-link: `study-software-design` — when the mapped transcript earns a `<Message>` component.

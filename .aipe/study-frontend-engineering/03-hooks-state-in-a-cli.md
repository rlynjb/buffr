# 03 — Hooks state in a CLI

**Industry name(s):** local component state · the `useState` triad ·
functional state updates. **Type:** Industry standard.

## Zoom out, then zoom in

This is the part of the codebase where your React is *exactly* your React.
Three `useState` calls, one event handler, and a render that's a pure
function of the three. No store, no context, no reducer, no URL state —
the smallest honest state graph a real interactive app can have. The only
thing the terminal changes is what those state changes paint to.

```
  Zoom out — where state lives in buffr-laptop

  ┌─ Render layer  Ink reconciler ──────────────────────────┐
  │  re-renders <Chat> whenever a setState fires             │
  └───────────────────────────────▲──────────────────────────┘
                                  │ triggers re-render
  ┌─ State layer  src/cli/chat.tsx:11-13 ──────────────────┐
  │  ★ useState: turns · input · busy ★      ← we are here  │
  └───────────────────────────────┬──────────────────────────┘
                                  │ onSubmit mutates all three
  ┌─ Data layer  session.ask() ───▼──────────────────────────┐
  │  the async source the transcript appends from            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **local component state with functional
updaters.** Three independent slices, one transition (`onSubmit`) that
touches all three in sequence. The question this answers: *what's the
minimum state that makes a chat REPL reactive, and how does one event
drive it?*

## Structure pass

**Layers.** One component, three state slices, one transition. That's the
whole graph — there's nothing nested to decompose, which is itself the
finding: this is `useState` with no abstraction layered on top.

**Axis — trace "who owns this, and when does it change?" across the three
slices.** State-ownership and lifecycle is the right axis here:

```
  one question across the three slices

  "who writes it, and when?"

  ┌─ turns ──────┐  ┌─ input ──────┐  ┌─ busy ───────┐
  │ written on   │  │ written per  │  │ written      │
  │ submit +     │  │ keystroke    │  │ around the   │
  │ on answer    │  │ (onChange)   │  │ await        │
  │ append-only  │  │ replace      │  │ true→false   │
  └──────────────┘  └──────────────┘  └──────────────┘
   slow, durable     fast, ephemeral   gate / mode flag
```

Three different write rhythms: `turns` grows on submit and answer,
`input` churns per keystroke, `busy` flips around the async boundary. Same
axis, three answers — that contrast is why they're separate slices and not
one object.

**Seam.** The load-bearing seam is `onSubmit` (`chat.tsx:15-35`) — the one
place all three slices are written, in a fixed order, straddling the
`await`. Everything about how the UI transitions lives in that handler.

## How it works

#### Move 1 — the mental model

You know how a `fetch()`-driven component has three things in flight:
loading, the data, and the input that triggered it? Same three here.
`busy` is loading, `turns` is the accumulated data, `input` is the field.
The twist: `turns` is *append-only* — you never replace it, you spread the
old array and push. The transcript is an event log, not a mutable record.

```
  the state triad — three slices, one transition

   ┌─ input ─┐   onSubmit fires
   │ "hello" │ ──────────────────┐
   └─────────┘                   ▼
                        ┌──────────────────────┐
   input → ''           │  1. clear input       │
   turns → [...t, you]  │  2. echo user turn    │  (before await)
   busy  → true         │  3. flip busy on      │
                        │     … await ask …     │
   turns → [...t, buffr]│  4. append answer     │  (after await)
   busy  → false        │  5. flip busy off     │
                        └──────────────────────┘
```

#### Move 2 — the walkthrough

**`turns` is append-only, updated with a functional setter.** Bridge from
what you know: you've written `setItems(prev => [...prev, newItem])` a
thousand times. That's exactly `setTurns((t) => [...t, {role,text}])` at
`chat.tsx:25` and `:29`. The functional form (`t => ...`) matters here for
a concrete reason: between the submit (`:25`) and the answer (`:29`) there's
an `await`, so the `turns` you captured at submit time is stale by the time
the answer lands. Reading `prev` inside the setter gets the *current*
array, not the closed-over one. Where it breaks if you use the
value form: `setTurns([...turns, answer])` would drop any turn that landed
during the await.

```
  Execution trace — turns across one submit

  step                        turns value
  ────────────────────────    ─────────────────────────────
  before submit               [ ]
  setTurns(t=>[...t, you])    [ {you,"hello"} ]
  … await session.ask …       [ {you,"hello"} ]            (unchanged)
  setTurns(t=>[...t, buffr])  [ {you,"hello"}, {buffr,"hi"} ]
                                       ▲
                                reads CURRENT array via t,
                                not the one captured at submit
```

**`input` is a controlled string, cleared on submit.** The field's value
*is* `input` (`chat.tsx:55`), written per keystroke by `setInput` via
`onChange`, and cleared with `setInput('')` at `chat.tsx:24` the instant
submit fires — before the await, so the field empties immediately and the
user can't see their old text lingering. The mechanics of the controlled
binding are `05-controlled-text-input.md`'s subject; this file owns only
that `input` is a state slice that gets reset on submit.

**`busy` is a mode flag straddling the await.** Set `true` at
`chat.tsx:26` right after echoing the user turn, reset `false` in the
`finally` at `chat.tsx:32-34`. Two jobs: it's the guard (`if (busy) return`
at `:17` blocks double-submit) and the render switch (input vs spinner at
`:48`). Putting the reset in `finally` is the load-bearing detail — on
*either* success or error, `busy` returns to `false` and the input comes
back. Where it breaks without `finally`: an error throws past the reset,
`busy` stays `true` forever, and the input never returns — the app wedges.
The async dimension is `04-async-ui-with-a-busy-flag.md`'s subject; here
it's just the third slice.

**Move 2 variant — the load-bearing skeleton.** The kernel of this state
graph is three parts, named by what breaks:

1. **The append-only `turns` with a functional updater.** Drop the
   functional form and concurrent turns get lost across the await. Drop
   append-only (mutate in place) and React doesn't see a new reference, so
   it bails out of re-rendering — the new turn never paints.
2. **The `input` reset on submit.** Drop it and the field keeps the
   submitted text, so the next keystroke appends to the old question.
3. **The `busy` flip in `finally`.** Drop the `finally` and an error
   leaves the UI stuck in the busy state with no input.

Optional hardening: the `q.trim()` and empty-guard at `chat.tsx:16,23`
(rejects whitespace-only submits) and the `/exit` branch at `:18` are
input-handling polish, not the state skeleton.

#### Move 3 — the principle

State slices should be split by *write rhythm*, not by what feels related.
`turns`, `input`, and `busy` are three slices because they're written on
three different schedules — submit, keystroke, async-boundary. Merging
them into one `useState({turns, input, busy})` object would force every
keystroke to spread-copy the entire transcript. Separate slices means each
write touches only what changed. That's the same instinct that says
"don't put your whole form in one state object if one field updates 60
times a second."

## Primary diagram

The full state graph and the one transition that drives it, in one frame.

```
  The useState triad — declared, then driven by onSubmit

  declared:  chat.tsx:11   const [turns, setTurns] = useState<Turn[]>([])
             chat.tsx:12   const [input, setInput] = useState('')
             chat.tsx:13   const [busy,  setBusy ] = useState(false)

  onSubmit (chat.tsx:15-35):
  ┌──────────────────────────────────────────────────────────┐
  │  guard:  if (busy) return                    :17  (busy)  │
  │  guard:  if /exit → close + exit             :18         │
  │  guard:  if (!q) return                      :23  (input) │
  │  setInput('')                                :24  (input) │
  │  setTurns(t => [...t, {you, q}])             :25  (turns) │
  │  setBusy(true)                               :26  (busy)  │
  │     ── await session.ask(q) ──               :28         │
  │  setTurns(t => [...t, {buffr, answer}])      :29  (turns) │
  │  catch → setTurns(t => [...t, {buffr, err}]) :31  (turns) │
  │  finally → setBusy(false)                    :33  (busy)  │
  └──────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The state is declared once at mount (`chat.tsx:11-13`) and
driven entirely by `onSubmit` (`chat.tsx:15-35`) for question turns, plus
`setInput` per keystroke via the controlled input. There is no other state
writer in the app.

```
  src/cli/chat.tsx  (lines 11-13) — the whole state graph

  const [turns, setTurns] = useState<Turn[]>([]);  ← transcript, append-only
  const [input, setInput] = useState('');          ← controlled field value
  const [busy,  setBusy ] = useState(false);       ← in-flight gate + render switch
       │
       └─ three slices, three write rhythms. No store, no context, no reducer —
          this is local component state in its purest form.
```

```
  src/cli/chat.tsx  (lines 24-34) — onSubmit drives all three

  setInput('');                                    ← input: clear field now
  setTurns((t) => [...t, { role: 'you', text: q }]);← turns: echo user (functional!)
  setBusy(true);                                    ← busy: flip on, swap to spinner
  try {
    const answer = await session.ask(q);            ← the async boundary
    setTurns((t) => [...t, { role: 'buffr', text: answer }]); ← turns: append answer
  } catch (err) {
    setTurns((t) => [...t, { role: 'buffr', text: `error: …` }]);← turns: append error
  } finally {
    setBusy(false);                                 ← busy: ALWAYS reset (load-bearing)
  }
       │
       └─ the functional t => [...t, …] form reads the CURRENT turns across the
          await; the finally guarantees busy resets on success OR error.
```

## Elaborate

`useState` with functional updaters is the substrate every React state
library is built on top of — Redux, Zustand, Jotai all reduce to "hold a
value, give me a setter, re-render on change." This file is interesting
precisely because it *doesn't* reach for any of them: three `useState`
calls are exactly right for three slices owned by one component. Reaching
for a store here would be the over-engineering tell.

The one place a reducer *would* help: if the three slices had to change
together atomically under more transitions, `useReducer` would centralize
the "input→'' , turns+=you, busy=true" sequence into a named action. With
one transition, three `useState` calls are simpler — and simpler wins.

The *async* dimension of `busy` (why the spinner, why `finally`, the
double-submit guard) is `04-async-ui-with-a-busy-flag.md`. The *controlled*
dimension of `input` (the value/onChange binding, the raw-mode read) is
`05-controlled-text-input.md`. This file owns the state shape; those two
own its two interesting edges.

## Interview defense

**Q: "Why three separate `useState` calls instead of one state object?"**
Verdict: because they're written on three different rhythms — `input` per
keystroke, `turns` on submit, `busy` around the await. One object means
every keystroke spread-copies the whole transcript. Split slices means
each write touches only what changed.

```
   input  → churns per keystroke   ─┐
   turns  → grows on submit/answer  ─┼─ different rhythms → different slices
   busy   → flips around await      ─┘
```

**Q: "Why the functional setter `t => [...t, x]` instead of `[...turns,
x]`?"** Because there's an `await` between the two `setTurns` calls. The
`turns` captured at submit is stale by the time the answer lands; the
functional form reads the current array. The load-bearing detail people
miss: without it, any turn that arrived during the await gets dropped.
Anchor: `chat.tsx:25` and `:29`.

**If you don't know:** "I know `turns` is append-only and updated with a
functional setter, and `busy` resets in a `finally` — I'd trace the exact
order in `onSubmit` at `chat.tsx:15-35` to confirm the sequence."

## Validate

1. **Reconstruct:** name the three state slices, their types, and their
   write rhythm (`chat.tsx:11-13`).
2. **Explain:** why is `setTurns` called with `t => [...t, x]` and not
   `[...turns, x]`? Tie it to the `await` at `chat.tsx:28`.
3. **Apply:** you want an "editing a past turn" feature. Why does that
   break the append-only assumption, and what would you change?
4. **Defend:** someone refactors the three slices into one
   `useState({turns, input, busy})`. What's the concrete cost on every
   keystroke?

## See also

- `00-overview.md` — the state graph diagram.
- `04-async-ui-with-a-busy-flag.md` — the async edge of `busy`.
- `05-controlled-text-input.md` — the controlled edge of `input`.
- `01-react-without-the-dom.md` — what these state changes repaint.

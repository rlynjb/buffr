# 04 — Async UI with a busy flag

**Industry name(s):** loading state · pending flag · in-flight guard ·
the `try/finally` reset. **Type:** Industry standard.

## Zoom out, then zoom in

Every async UI you've shipped has this shape: fire the request, show a
spinner, swap the spinner for the result, and make sure the spinner clears
even when the request throws. Here it's one boolean — `busy` — doing three
jobs at once: it's the loading indicator, it's the double-submit guard,
and it's the render switch between the input and the spinner. One flag,
straddling one `await`.

```
  Zoom out — where the busy flag sits in buffr-laptop

  ┌─ Render  Ink ───────────────────────────────────────────┐
  │  busy ? <Spinner/> : <TextInput/>     chat.tsx:48-57     │
  └───────────────────────────────▲──────────────────────────┘
                                  │ busy gates the render
  ┌─ State  chat.tsx:13 ──────────┴─────────────────────────┐
  │  ★ busy: boolean ★   set around the await   ← we are here│
  └───────────────────────────────┬──────────────────────────┘
                                  │ true before, false in finally
  ┌─ Data  session.ask() ─────────▼──────────────────────────┐
  │  the seconds-long agent turn the spinner covers          │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a pending flag wrapped around an async call,
reset in `finally`.** The question this answers: *how does the terminal
stay responsive and honest while an LLM turn takes seconds?*

## Structure pass

**Layers.** Three: the async source (`session.ask`, seconds long), the
flag that tracks its in-flight state (`busy`), and the render that reads
the flag. The flag is the joint between a slow async operation and a
synchronous render.

**Axis — trace "is a turn in flight?" from the call site to the pixels.**
The state axis, but specifically the *pending* dimension:

```
  one question, from call to paint

  "is a turn in flight right now?"

  ┌─ before await ─┐  ┌─ during await ─┐  ┌─ after await ─┐
  │ busy = true    │  │ busy = true     │  │ busy = false   │
  │ (set at :26)   │  │ (the agent runs)│  │ (finally :33)  │
  │ render: spinner│  │ render: spinner │  │ render: input  │
  └────────────────┘  └─────────────────┘  └────────────────┘
   guard active        guard active         guard released
```

The answer is `true` across the entire async window and flips back to
`false` only in `finally` — on success *or* error. That single flip-point
is the seam.

**Seam.** The load-bearing seam is the `try/finally` boundary
(`chat.tsx:27-34`). `busy` goes true *before* the `try`, and the `finally`
is the one place it comes back false — which is what guarantees the input
returns no matter how the await ends.

## How it works

#### Move 1 — the mental model

You know the three states of a `fetch`: idle, pending, settled. `busy`
collapses that into a boolean — `false` is idle/settled, `true` is
pending. The trick is that "pending" has to be *bracketed* around the
async call: turn it on the instant you fire, turn it off the instant it
settles, and "settles" includes throwing.

```
  the bracketed-pending pattern

   setBusy(true)  ──┐
                    │   ┌─────────────────────┐
                    └──►│  await session.ask  │  ← the slow part
                        └──────────┬──────────┘
                                   │ resolves OR throws
   setBusy(false) ◄────────────────┘
   (in finally — runs on BOTH paths)
```

#### Move 2 — the walkthrough

**The flag goes true before the await, and gates the render.** Bridge from
what you know: this is `setLoading(true)` before `await fetch()`. At
`chat.tsx:26` `setBusy(true)` fires right after the user turn is echoed,
and the render at `chat.tsx:48` reads it: `busy ? <Spinner/> : <input>`.
The instant busy flips, Ink re-renders and the input disappears, replaced
by `⠋ thinking…` (`chat.tsx:49-51`). Where it breaks if you set it late:
set busy *after* the await and the spinner never shows — the UI just
freezes silently for the seconds the turn takes.

**The flag is also the double-submit guard.** This is the part a plain
`fetch` loading state often skips. At `chat.tsx:17`, `if (busy) return` —
the very first thing `onSubmit` does. While a turn is in flight, the input
is replaced by a spinner so there's no field to type in, *but* the guard
is belt-and-suspenders: even if a submit somehow fired during busy, it's
rejected. Where it breaks without the guard: a fast double-`Enter` could
fire two `session.ask` calls, double-spending an LLM turn and racing two
appends onto `turns`.

```
  Pattern — busy as both render-switch and guard

                  ┌── if (busy) return  ───────┐  guard (chat.tsx:17)
   Enter pressed ─┤                             │
                  └── else: setBusy(true) ──────┘
                            │
                            ▼
              render flips: input → spinner      switch (chat.tsx:48)
                            │
                   (no input to type in while busy)
```

**The flag resets in `finally`, on every exit path.** The kernel detail.
`session.ask` can resolve (answer) or throw (error). Both must return the
UI to ready. The `try` appends the answer (`:29`), the `catch` appends an
error turn (`:31`), and the `finally` resets busy (`:33`) — so the input
returns whether the turn succeeded or failed. Where it breaks without
`finally`: put `setBusy(false)` at the end of `try` and an error skips it,
leaving busy stuck `true` — the spinner spins forever and the app is
wedged with no way to type.

```
  Layers-and-hops — busy across the async boundary

  ┌─ onSubmit  chat.tsx ─┐  hop 1: setBusy(true)    ┌─ Render ────────┐
  │  setBusy(true) :26    │ ───────────────────────► │ show <Spinner/> │
  │  try {                │                           └─────────────────┘
  │    await ask(q) :28   │  ── seconds: agent runs ──
  │    setTurns(ans) :29  │  hop 2a: resolve → answer turn
  │  } catch {            │  hop 2b: throw   → error turn
  │    setTurns(err) :31  │
  │  } finally {          │  hop 3: setBusy(false)    ┌─ Render ────────┐
  │    setBusy(false) :33 │ ───────────────────────► │ show <TextInput>│
  │  }                    │  (BOTH paths reach here)  └─────────────────┘
  └───────────────────────┘
```

**Move 2 variant — the load-bearing skeleton.** Three parts, named by what
breaks:

1. **`setBusy(true)` before the await.** Drop it and there's no loading
   feedback — the terminal freezes silently for seconds.
2. **The `busy` guard at the top of `onSubmit`.** Drop it and a
   double-submit double-spends the LLM call.
3. **`setBusy(false)` in `finally`.** Drop the `finally` (reset only on
   success) and an error wedges the UI in the busy state forever.

Optional hardening: the spinner *type* (`dots`) and the `thinking…` label
(`chat.tsx:49-51`) are cosmetic; the error-to-turn rendering
(`chat.tsx:31`) is graceful-degradation polish. The skeleton is
set-true / guard / reset-in-finally.

#### Move 3 — the principle

A loading flag isn't just "show a spinner" — it's the single source of
truth for "is an operation in flight," and *everything* that depends on
that fact should read the same flag: the indicator, the guard, the
disabled-input. The bug people ship is having three separate booleans
(`loading`, `submitting`, `disabled`) that can drift out of sync. One flag,
reset in `finally`, can't drift.

## Primary diagram

The full busy lifecycle, one frame: declared, set, guarding, switching,
reset.

```
  The busy flag — full lifecycle

  declared:  chat.tsx:13   const [busy, setBusy] = useState(false)

  onSubmit (chat.tsx:15-35):
  ┌─────────────────────────────────────────────────────────────┐
  │  :17   if (busy) return            ← GUARD: reject re-entry   │
  │  :26   setBusy(true)               ← SET: spinner appears     │
  │  :27   try {                                                  │
  │  :28     await session.ask(q)      ← the seconds-long turn    │
  │  :29     setTurns(+answer)         ← success path             │
  │  :30   } catch {                                              │
  │  :31     setTurns(+error)          ← failure path             │
  │  :32   } finally {                                            │
  │  :33     setBusy(false)            ← RESET: input returns     │
  │  :34   }                              (BOTH paths)            │
  └─────────────────────────────────────────────────────────────┘

  render (chat.tsx:48-57):
     busy ? <Spinner type="dots"/> thinking…   :  <TextInput .../>
            ▲ in-flight                            ▲ ready
```

## Implementation in codebase

**Use cases.** Reached for on every question turn. The user types a
question, hits Enter, and for the seconds the agent retrieves + generates,
`busy` covers the gap with a spinner and blocks a second submit. It's the
only async-feedback mechanism in the app.

```
  src/cli/chat.tsx  (lines 17, 26-34) — the busy bracket

  if (busy) return;                         ← :17  guard: no re-entry mid-turn
  …
  setBusy(true);                            ← :26  flip on → render shows spinner
  try {
    const answer = await session.ask(q);    ← :28  the slow async call
    setTurns((t) => [...t, {role:'buffr', text: answer}]); ← :29  success
  } catch (err) {
    setTurns((t) => [...t, {role:'buffr', text:`error: …`}]);← :31  failure, no crash
  } finally {
    setBusy(false);                         ← :33  ALWAYS reset (load-bearing)
  }
       │
       └─ busy true before await, false in finally → the input returns on
          success OR error; the guard at :17 prevents double-spend.
```

```
  src/cli/chat.tsx  (lines 48-57) — busy is the render switch

  {busy ? (
    <Text color="yellow">
      <Spinner type="dots" /> thinking…      ← :49-51  in-flight indicator
    </Text>
  ) : (
    <Box>
      <Text color="cyan">{'> '}</Text>
      <TextInput value={input} … />          ← :55  ready: the input is back
    </Box>
  )}
       │
       └─ one boolean chooses the entire bottom region: spinner xor input.
          There's no separate "disabled input" state — busy removes the input outright.
```

## Elaborate

The `try/finally` reset is the same discipline as releasing a lock or
closing a file handle: the cleanup must run on the error path, not just the
happy path. React UIs get this wrong constantly — `setLoading(false)` at
the end of `try` is one of the most common bugs in production frontends,
because it leaves the spinner stuck whenever the request rejects. The
`finally` is non-negotiable.

Note what this app *doesn't* do, and correctly: no retry, no cancellation,
no timeout. A failed turn becomes an error turn and the user retypes
(`audit.md` lens 4). Auto-retry would silently double-spend an LLM call;
cancellation would need an `AbortController` threaded through
`session.ask`, which the seam doesn't expose. For a single-user REPL,
"fail visibly, let the human retry" is the right call. The *runtime*
mechanics of how the `await` suspends and resumes on the event loop are
`study-runtime-systems`'s lens; this file owns only the UI-state side of
the async boundary.

## Interview defense

**Q: "How does the UI handle the seconds an LLM turn takes?"** Verdict: one
boolean, `busy`, bracketed around the await. Set true before, reset in
`finally`, and the render switches input-for-spinner on it.

```
   setBusy(true) → [await ask] → finally setBusy(false)
        │                              │
        ▼                              ▼
     spinner                        input back
```

The load-bearing part I'd name: the reset is in `finally`, not at the end
of `try` — so an error doesn't wedge the spinner. Anchor: `chat.tsx:33`.

**Q: "One flag does the indicator and the guard — is that a smell?"** No,
it's the opposite. "Is a turn in flight" is one fact; having it drive both
the spinner and the double-submit guard means they can't disagree. Two
separate booleans would be the smell — they'd drift. The guard at
`chat.tsx:17` and the render switch at `:48` read the same `busy`.

**If you don't know:** "I know `busy` brackets the await and resets in
`finally`, and it's both the spinner switch and the re-entry guard — I'd
re-read `onSubmit` at `chat.tsx:15-35` to confirm the exact set/reset
points."

## Validate

1. **Reconstruct:** draw busy's lifecycle — where it's set, where it's
   reset, what reads it. Name the lines (`:26`, `:33`, `:17`, `:48`).
2. **Explain:** why is `setBusy(false)` in `finally` and not at the end of
   `try`? What concretely breaks if you move it?
3. **Apply:** add a "stop generating" button. What does `busy` need to
   become, and what does `session.ask` need to expose? (AbortController.)
4. **Defend:** someone replaces `busy` with three booleans `loading`,
   `submitting`, `inputDisabled`. What's the failure mode? (Drift —
   they can disagree.)

## See also

- `00-overview.md` — the #2 highest-leverage pattern.
- `03-hooks-state-in-a-cli.md` — busy as one of the three state slices.
- `02-the-session-as-the-data-layer.md` — the `ask` this brackets.
- `study-runtime-systems` — how the await suspends on the event loop.

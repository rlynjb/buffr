# async-ui-with-a-busy-flag

*The loading-state triad · async UI / pending-error-success · Industry standard*

## Zoom out, then zoom in

You know the loading-state triad cold: every `fetch()` you have ever wired up has a
loading flag, a success path, and an error path, and the UI reads the flag to decide what
to show. `<Chat>` is that exact pattern, except the "fetch" is a local async function
(`session.ask`) that fans out to a database and a model, and the loading indicator is a
terminal spinner instead of a CSS skeleton.

```
  Zoom out — where the busy flag sits in the surface

  ┌─ UI layer (terminal) ───────────────────────────────────────┐
  │  <Chat>  src/cli/chat.tsx:9                                  │
  │   ┌───────────────────────────────────────────────────────┐ │
  │   │ ★ busy flag brackets the await ★          chat.tsx:13  │ │ ← we are here
  │   │   setBusy(true) → await ask() → setBusy(false)         │ │
  │   │   render: busy ? <Spinner> : <TextInput>   chat.tsx:48 │ │
  │   └───────────────────────────────────────────────────────┘ │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  await session.ask(q)
  ┌─ Data layer ──────────────────▼──────────────────────────────┐
  │  ChatSession.ask()  src/session.ts:60                        │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is **pending-state-as-derived-render**: a boolean tracks "is a
request in flight," `try/catch/finally` guarantees the boolean is restored no matter how the
request ends, and the render branches on the boolean. The question it answers: *how does the
UI stay honest about in-flight work — never stuck spinning, never accepting a second submit
mid-flight?*

## Structure pass

One axis: **failure — where does it originate, propagate, and get contained?** This is the
right axis here because the whole point of `try/catch/finally` is failure containment.

```
  One axis — "where does failure go?" — across the async call

  ┌─ try ─────────────────────────────────────────────────┐
  │  await session.ask(q)   ← failure ORIGINATES here      │  chat.tsx:28
  └───────────────────────────────────────────────────────┘
  ┌─ catch ───────────────────────────────────────────────┐
  │  failure CONTAINED as an error turn, not a crash       │  chat.tsx:30-32
  └───────────────────────────────────────────────────────┘
  ┌─ finally ─────────────────────────────────────────────┐
  │  setBusy(false) — runs on BOTH paths                   │  chat.tsx:33
  └───────────────────────────────────────────────────────┘

  failure flips from "throws" to "rendered turn" at the catch seam —
  and the finally guarantees the flag resets regardless of which path won
```

- **Layers:** the guard (`if (busy) return`) → the try (the await) → the catch → the finally.
- **Axis:** failure. It originates inside `session.ask()`, is *contained* at the catch into a
  rendered `error:` turn (`chat.tsx:31`), and the `busy` flag is *restored* in the finally
  regardless of path.
- **The load-bearing seam:** the `finally` block. It is the boundary where "the request is
  in flight" becomes "the request is done," and it sits outside both the success and error
  paths so the flag can never get stranded. *If failure flips anywhere, it flips at catch;
  if the flag resets anywhere, it resets at finally.* That separation is the skeleton.

## How it works

### Move 1 — the mental model

Think of the three states your UI can be in as a tiny state machine, the same one you draw
for any `fetch`:

```
  The pattern — the pending-state machine

         idle (input shown)
            │  onSubmit, q valid
            ▼
         pending (spinner)  ◄─── busy = true
          /        \
   resolved        rejected
   +buffr turn     +error turn
          \        /
            ▼    ▼
         idle (input shown)  ◄─── busy = false  (finally, both paths)
```

The strategy in one sentence: **set the flag before the work, clear it in a `finally` so
both success and failure return you to idle, and let the render derive what to show from the
flag.** The flag is never set or cleared in two places that could disagree — `true` once
before, `false` once in finally.

### Move 2 — the walkthrough

#### The guard — refuse a second submit while one is in flight

```tsx
// src/cli/chat.tsx:16-17
const q = value.trim();
if (busy) return;          // already working — drop this submit
```

Before anything else, `onSubmit` checks `busy` and bails if a request is already running.
This is the affordance that keeps the UI honest: hit enter twice fast and the second press
is a no-op, so you can't fire two overlapping `ask()` calls into one conversation. The
boundary condition: this guard reads `busy` from the render closure, which is correct here
because each render gets a fresh `onSubmit` with the current `busy` — but it is *only* a UI
guard. It does not cancel the in-flight call; it just refuses to start a new one. (The
missing cancellation is `audit.md` red-flag 3.)

#### The optimistic append + flag set — before the await

```tsx
// src/cli/chat.tsx:24-26
setInput('');                                       // clear the field immediately
setTurns((t) => [...t, { role: 'you', text: q }]);  // show the user's turn at once
setBusy(true);                                       // enter pending state
```

All three of these run *synchronously before* the await, so the UI updates the instant you
hit enter: field clears, your question appears, spinner takes over. This is optimistic in
the small — the user's turn is shown before the answer exists, which is correct because the
question is *theirs*, not server-derived; there is nothing to roll back. The boundary
condition: if `setBusy(true)` came *after* the await instead, the spinner would never show —
the flag has to flip before you yield to the event loop.

#### The try/catch/finally — the containment skeleton

```tsx
// src/cli/chat.tsx:27-34
try {
  const answer = await session.ask(q);                              // the work
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);          // success path
} catch (err) {
  setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); // error path
} finally {
  setBusy(false);                                                    // ALWAYS restore
}
```

This is the skeleton — name each part by what breaks if it is missing:

- **`try` + `await`** — the work. Remove it and there is no async call to track.
- **`catch`** — failure containment. Remove it and a thrown error from `session.ask()`
  becomes an unhandled rejection: the spinner stays up forever (the finally would still run,
  actually — but without catch the error escapes to the console and the user sees nothing
  useful). The catch turns a throw into a *rendered* `error:` turn (`chat.tsx:31`), so the
  user sees what went wrong and the conversation continues.
- **`finally` + `setBusy(false)`** — the load-bearing reset. Remove it (or put `setBusy(false)`
  only in the try) and a thrown error leaves `busy` stuck `true` forever: the spinner spins
  with no input, the app is dead with no way to type. **This is the part people forget.** The
  whole reason `setBusy(false)` lives in `finally` and not at the end of `try` is so the error
  path *also* resets the flag.

```
  Execution trace — busy on both exit paths

  step                       busy    footer shown
  ───────────────────────    ────    ──────────────
  setBusy(true)   :26        true    <Spinner> thinking…
  await ask() …              true    <Spinner> thinking…
  ── success ──              true    <Spinner> thinking…
  setTurns(+buffr) :29       true    <Spinner> thinking…
  finally setBusy(false):33  false   <TextInput>            ✓
  ── OR error ──             true    <Spinner> thinking…
  catch setTurns(+err):31    true    <Spinner> thinking…
  finally setBusy(false):33  false   <TextInput>            ✓  same reset, error path
```

#### The render branch — the flag drives the footer

```tsx
// src/cli/chat.tsx:48-57
{busy ? (
  <Text color="yellow"><Spinner type="dots" /> thinking…</Text>   // pending
) : (
  <Box><Text color="cyan">{'> '}</Text><TextInput value={input} … /></Box>  // idle
)}
```

The render reads `busy` and shows either the spinner or the input — never both, because they
occupy the same footer slot. `<Spinner type="dots">` (`chat.tsx:49`) is Ink's animated
spinner, the terminal analog of a CSS loading skeleton; it animates on its own timer while
mounted. The boundary condition: while `busy` is true the `<TextInput>` is unmounted, which
is *why* the guard on line 17 is almost redundant — there is no field to submit from while
spinning. Almost: a buffered keystroke or a fast double-enter can still fire `onSubmit`
during the transition, so the guard stays as the real lock.

### Move 3 — the principle

**Put the cleanup in `finally`, not at the end of the happy path.** Any flag, lock, or
resource you acquire before an `await` must be released in a `finally` so the error path
releases it too. The single most common version of this bug — a loading spinner stuck
forever after a failed request — is exactly the bug this `finally` prevents. The principle is
language- and framework-agnostic: it is the same reason you `finally { conn.release() }` a DB
connection or `finally { setLoading(false) }` a React query. Acquire before, release in
finally, derive the view from the flag.

## Primary diagram

The complete async cycle, flag and failure paths labeled.

```
  async-ui-with-a-busy-flag — the complete frame

  ┌─ onSubmit  src/cli/chat.tsx:15 ──────────────────────────────┐
  │  guard:  if (busy) return                       :17          │
  │  pre:    setInput('') · setTurns(+you) · setBusy(true) :24-26│
  │                                                              │
  │  ┌─ try ──────────────────────────────────────────────────┐ │
  │  │  answer = await session.ask(q)                :28       │ │
  │  │  setTurns(+buffr)                             :29       │ │ success
  │  ├─ catch ────────────────────────────────────────────────┤ │
  │  │  setTurns(+ `error: …`)                       :31       │ │ contained
  │  ├─ finally ──────────────────────────────────────────────┤ │
  │  │  setBusy(false)   ← BOTH paths reach here     :33       │ │ ★ load-bearing
  │  └────────────────────────────────────────────────────────┘ │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ busy drives the render
                                  ▼
  ┌─ render footer  chat.tsx:48 ─────────────────────────────────┐
  │  busy ? <Spinner> thinking…   :  <TextInput value={input}/>  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

This hand-rolled triad is what query libraries (react-query, SWR) productize: they give you
`isLoading`/`isError`/`data` so you don't write the `try/catch/finally` yourself, plus
caching, retry, and dedup. This codebase doesn't need them — there is one call site, no
cache to share, no second consumer of the result — so the explicit triad is the honest
choice; pulling in react-query for one `await` would be ceremony. The seam where you *would*
graduate to a library: a second screen that re-fetches the same data, or a need for retry/
optimistic-mutation-with-rollback. Until then, `try/catch/finally` + a boolean is the whole
pattern, and it is the same pattern under the library's hood. Next:
`04-session-as-the-data-layer.md` walks what `session.ask()` actually does on the other side
of that await.

## Interview defense

**Q: Why is `setBusy(false)` in `finally` instead of at the end of the `try`?**

```
  setBusy(false) at end of try        setBusy(false) in finally
  ────────────────────────────        ─────────────────────────
  success → reset ✓                   success → reset ✓
  error   → skipped! spinner          error   → reset ✓
            stuck forever ✗
```

Because the error path has to reset the flag too. If `setBusy(false)` lived at the end of the
try, a thrown error from `session.ask()` would jump to the catch and *skip* the reset — the
spinner would spin forever with no input field, a dead UI. `finally` runs on both the success
and error paths, so the flag is always restored. This is the bug everyone has shipped once.
Anchor: *"the flag resets in finally so the error path resets it too — otherwise the spinner
gets stranded."*

**Q: The user double-taps enter on a slow model. What happens?**

The first submit sets `busy = true` and unmounts the `<TextInput>` (`chat.tsx:48,55`); the
`if (busy) return` guard (`chat.tsx:17`) catches any second `onSubmit` that still fires during
the transition. So the second tap is a no-op — you can't fan out two overlapping `ask()` calls
into one conversation. What's *missing* is cancellation: the guard refuses a new request but
can't abort the running one, so a slow Ollama generation locks the UI in `thinking…` until it
finishes. That's the honest gap (`audit.md` red-flag 3). Anchor: *"`busy` is a re-entrancy
guard, not a cancel — it blocks a second call but can't abort the first."*

## See also

- `02-hooks-state-in-a-cli.md` — the `busy` slice and the functional updaters used here.
- `04-session-as-the-data-layer.md` — what runs inside the `await session.ask(q)`.
- `01-react-without-the-dom.md` — how the footer swap (Spinner↔TextInput) gets painted.
- Cross-link: `study-runtime-systems` — the event-loop suspension at the `await`, and the
  missing cancellation token.

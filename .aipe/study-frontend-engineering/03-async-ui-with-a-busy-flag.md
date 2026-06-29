# Async UI with a busy flag — the loading state

**Industry name(s):** loading/success/error state machine · the `isLoading` / `isFetching` flag · async UI guard. **Type:** Industry-standard pattern (every async UI), project-specific: hand-rolled, no query library.

---

## Zoom out, then zoom in

Every UI that awaits something has this machine: idle → loading → (success | error) → idle. Buffr hand-rolls it around one awaited call with a single boolean. Here's where it sits — it's the bridge between a synchronous render and an asynchronous data layer.

```
  Zoom out — the busy flag straddles sync UI and async data

  ┌─ UI layer (synchronous render) ──────────────────────┐
  │  <Chat>  ★ busy: idle | loading ★                     │ ← we are here
  │          render branch: spinner ⇄ input               │
  └───────────────────────────┬──────────────────────────┘
                  await ask()  │  (the async hop)
  ┌─ Data layer (asynchronous) ▼─────────────────────────┐
  │  session.ask(): persist → agent.answer() → remember   │
  └───────────────────────────┬──────────────────────────┘
                  pg + Ollama  │
  ┌─ Storage / Provider ──────▼──────────────────────────┐
  │  Postgres · Ollama (gemma2)                            │
  └───────────────────────────────────────────────────────┘
```

**Zoom in:** the concept is the **async UI state machine** — the discipline of representing "something is in flight" as explicit state so the render can show progress and the handler can refuse to re-enter. Buffr's whole machine is one `boolean busy` plus a `try/finally` (`src/cli/chat.tsx:13–35`). The interesting parts: the re-entrancy guard and the `finally` that *cannot* be skipped.

---

## The structure pass

One axis: **"can a second submit start work right now?"** Trace it across the turn's lifetime. The answer flips twice, and those two flips bound the critical section.

```
  Axis — "can new work start?" — across one turn

   submit ──► if(busy) return   ──► setBusy(true) ──► await ask() ──► finally setBusy(false)
              │                     │                                  │
   state:   idle (YES, allowed)   loading (NO, refused) ───────────── idle (YES again)
              ▲                     └──────── critical section ────────┘
              └─ guard reads the flag the critical section sets
```

- **Layers:** the submit handler (control) → the `busy` flag (state) → the render branch (view).
- **Axis (re-entrancy / control):** "can work start?" is YES at idle, NO during the await, YES again after `finally`. The guard at the top (`chat.tsx:17`) reads exactly the flag the body sets — that's a tiny mutual-exclusion lock built from one boolean.
- **The seam:** the `await` (`chat.tsx:28`). Above it the handler runs synchronously to completion in one tick; at the `await` it suspends and the event loop is free; below it (the continuation) runs in a later tick. The `finally` straddles both sides so the flag resets no matter which path — success or throw — the continuation takes. The event-loop mechanics of that suspend/resume belong to `study-runtime-systems`.

---

## How it works

### Move 1 — the mental model

You know a `fetch()` has three states you render differently — spinner while pending, data on resolve, message on reject. That's exactly this, with one addition: a **lock** so the user can't fire a second request while the first is pending.

```
  Pattern — the loading machine with a re-entrancy lock

        ┌────────── if(busy) return  (lock: refuse re-entry)
        │
   ┌────▼────┐  setBusy(true)   ┌───────────┐
   │  idle   │ ───────────────► │  loading  │
   └────▲────┘                  └─────┬─────┘
        │                     await ask()
        │            ┌───────────┴───────────┐
        │       resolve                    reject
        │            │                        │
        │     append answer            append error
        │            └───────────┬────────────┘
        └──── setBusy(false) ◄────┘  (finally: always runs)
```

The strategy in one sentence: **wrap the await in a flag that gates the render and locks re-entry, and reset it in `finally` so no path leaves the UI stuck.**

### Move 2 — the walkthrough

#### The guard — a one-boolean lock

```tsx
// src/cli/chat.tsx:15–17
const onSubmit = async (value: string): Promise<void> => {
  const q = value.trim();
  if (busy) return;          // ← refuse: a turn is already in flight
```

This is the first thing the handler does. Bridge from what you know: it's the same reason you disable a submit button while a form posts — except here the field is hidden during `busy` (the render shows a spinner instead, `chat.tsx:48`), so the guard is the backstop against a queued keypress or a programmatic re-entry. Without it, two fast submits fire two `session.ask()` calls into the *same* conversation, interleaving persistence and trace flushes. The guard reads `busy`; the body below sets it — that read/set pair is the whole lock.

#### Optimistic-ish: show the user's turn before awaiting

```tsx
// src/cli/chat.tsx:24–26
setInput('');                                       // clear the field immediately
setTurns((t) => [...t, { role: 'you', text: q }]);  // show YOUR turn now, before the await
setBusy(true);                                       // enter loading
```

Three synchronous setStates fire before any `await`, so the next render shows: empty field, your question on screen, spinner up. The user's own turn is **optimistic** — it appears without waiting for the backend, because there's nothing to confirm about your own input. The answer is *not* optimistic; it waits for the real result. This split (optimistic for the user echo, pessimistic for the response) is the right call: you can't fake the model's answer.

#### The await and the two outcomes

```tsx
// src/cli/chat.tsx:27–35
try {
  const answer = await session.ask(q);                          // the async hop
  setTurns((t) => [...t, { role: 'buffr', text: answer }]);     // success → append answer
} catch (err) {
  setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); // reject → append error
} finally {
  setBusy(false);                                                // ALWAYS → leave loading
}
```

Walk it: the handler suspends at `await session.ask(q)` and the render is already showing the spinner. When the promise settles, exactly one of two branches runs — append the answer, or append the stringified error. Then `finally` runs **on both paths**, flipping `busy` back to false, which re-renders the input field. Boundary condition, and the part people get wrong: put `setBusy(false)` at the end of `try` instead of `finally`, and any throw from `ask()` skips it — the spinner spins forever and the UI is wedged. The `finally` is load-bearing precisely because it's the one line that runs whether the await succeeds or blows up.

#### The render branch reads the flag

```tsx
// src/cli/chat.tsx:48–57
{busy ? (
  <Text color="yellow"><Spinner type="dots" /> thinking…</Text>
) : (
  <Box><Text color="cyan">{'> '}</Text>
    <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="ask buffr" />
  </Box>
)}
```

The flag the handler sets is the flag the view reads. `busy === true` mounts the spinner subtree; `false` mounts the input. The reconciler unmounts one and mounts the other on each flip (the `<TextInput>` is fully torn down during `busy`, which is *why* the guard exists — there's no field to type into mid-turn, but a buffered keystroke could still reach a handler).

### Move 2 variant — the load-bearing skeleton

Strip it to the irreducible core: **a boolean + a guard that reads it + a `finally` that resets it.** Three parts, named by what breaks:

- Drop the **guard** (`if (busy) return`) → concurrent turns; two `ask()` calls race into one conversation.
- Drop the **`finally`** (reset in `try` instead) → one thrown error wedges the UI on the spinner permanently.
- Drop the **render branch** on `busy` → no progress feedback; the UI looks frozen during a multi-second model call.

Optional hardening *not* present (and honestly so): no `AbortController` to cancel a slow turn (`audit.md` red flag #3), no timeout, no retry/backoff, no error-type discrimination. Those are the layers a production async machine adds on top of this skeleton.

### Move 3 — the principle

The reason async UI needs an explicit state machine is that **"in flight" is a real state the user must see and the handler must respect** — not an implementation detail you can leave implicit. A boolean is the minimum honest representation; a query library's `isLoading`/`isError`/`isSuccess` is the same machine with cancellation, caching, and retries bolted on. Buffr's version is correct and complete *for one in-flight call with no cancellation* — and knowing exactly which hardening it omits is what separates "I used a loading spinner" from "I built the loading state machine."

---

## Primary diagram

The full machine, flag and render branch together, across the async seam.

```
  buffr's async turn — the complete loading state machine

  ┌─ UI handler (src/cli/chat.tsx:15–35) ───────────────────┐
  │  if(busy) return ──guard──┐                             │
  │  setInput('') · append you · setBusy(true)              │
  │                           │                             │
  │      ┌── render: busy ? <Spinner/> : <TextInput/> ──┐   │  (chat.tsx:48)
  │      │                                              │   │
  │  try { await session.ask(q) } ═══════════════════════════╪═► async seam
  │      ├ resolve → append answer  (chat.tsx:29)            │
  │      ├ reject  → append error   (chat.tsx:31)            │
  │      └ finally → setBusy(false) (chat.tsx:32) ALWAYS     │
  └───────────────────────────┬─────────────────────────────┘
                  session.ask()│ persist → agent → remember
  ┌─ Data layer (src/session.ts:60) ▼───────────────────────┐
  │  Postgres write · Ollama generate · memory.remember      │
  └──────────────────────────────────────────────────────────┘
```

---

## Elaborate

This machine is the thing react-query, SWR, and TanStack Query exist to delete from your handlers — they own the flag, the dedup (your `if (busy) return` guard, generalized), the cache, retries, and cancellation, exposing `{ data, isLoading, isError }`. Buffr hand-rolls it because there's exactly one call site and no caching story, so a library would be ceremony. The honest read: this is the *correct* amount of machinery for the current surface. The trigger to adopt a library is a second async call site that needs the same dedup/cache/retry — at which point copy-pasting the flag becomes the smell.

Read next: `04-session-as-the-data-layer.md` (what's behind the await) and `02-hooks-state-in-a-cli.md` (`busy` among the state triad). The suspend/resume at the `await` is `study-runtime-systems`; the wire timeout/retry semantics under `ask()` are `study-networking`.

---

## Interview defense

**Q: "Walk me through what happens when a user submits a question."**

Guard, optimistic echo, loading, await, branch, reset. "First `if (busy) return` refuses re-entry. Then synchronously: clear the input, append the user's turn, set busy — so the next frame shows the question and a spinner. Then `await session.ask()`. On resolve I append the answer; on reject I append the error; `finally` clears busy regardless, which swaps the spinner back for the input."

```
  one turn, six beats
  guard → echo → busy=true → await → branch(ok|err) → finally busy=false
```

Anchor: *"One boolean is the whole loading machine; the `finally` is what guarantees it never wedges (chat.tsx:32)."*

**Q: "What's the bug if you move `setBusy(false)` out of `finally`?"**

If it's the last line of `try`, a throw from `ask()` skips it and the UI is stuck on the spinner forever — no input ever comes back. `finally` is the only placement that runs on both the resolve and reject paths. That's the load-bearing detail.

```
  finally vs end-of-try
  end of try:  throw → skipped → wedged spinner
  finally:     throw → still runs → UI recovers
```

**Q (follow-up): "What's missing from this machine?"** Cancellation — no `AbortController`, so `/exit` can't interrupt an in-flight turn (`audit.md` #3). Naming the omission unprompted is the senior signal.

---

## See also

- `02-hooks-state-in-a-cli.md` — `busy` within the state triad
- `04-session-as-the-data-layer.md` — what the await calls into
- `01-react-without-the-dom.md` — how the spinner⇄input swap reconciles
- `audit.md` lens 4 (data-fetching), red flag #3 (no cancellation)
- cross-link: `study-runtime-systems` (suspend/resume at the await), `study-networking` (timeout/retry on the wire)

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

**Zoom in:** the concept is the **async UI state machine** — the discipline of representing "something is in flight" as explicit state so the render can show progress and the handler can refuse to re-enter. Buffr's machine is one `boolean busy`, a `try/finally`, and a `<Spinner>` that ticks independently (`src/cli/chat.tsx`). The interesting parts: the re-entrancy guard, the `finally` that *cannot* be skipped, and the real-time elapsed + token counter that updates every 100ms regardless of the backend's pace.

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
// src/cli/chat.tsx — handleSubmit
const handleSubmit = (): void => {
  const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
  if (busy || !q) return;   // ← refuse: a turn is already in flight, or nothing to submit
```

This is the first thing the handler does. Bridge from what you know: it's the same reason you disable a submit button while a form posts — except here the field is hidden during `busy` (the render shows a spinner instead, `chat.tsx:48`), so the guard is the backstop against a queued keypress or a programmatic re-entry. Without it, two fast submits fire two `session.ask()` calls into the *same* conversation, interleaving persistence and trace flushes. The guard reads `busy`; the body below sets it — that read/set pair is the whole lock.

#### Optimistic-ish: show the user's turn before awaiting

```tsx
// src/cli/chat.tsx — handleSubmit (after guard)
taRef.current?.setText('');                            // clear the textarea buffer immediately
setTurns(t => [...t, { role: 'you', text: q }]);       // show YOUR turn now, before the await
setBusy(true);                                          // enter loading
setStatus('thinking…');
setLiveTokens({ input: 0, output: 0 });
```

Three synchronous setStates fire before any `await`, so the next render shows: empty field, your question on screen, spinner up. The user's own turn is **optimistic** — it appears without waiting for the backend, because there's nothing to confirm about your own input. The answer is *not* optimistic; it waits for the real result. This split (optimistic for the user echo, pessimistic for the response) is the right call: you can't fake the model's answer.

#### The async hop and the two outcomes

```tsx
// src/cli/chat.tsx — handleSubmit (after optimistic echo)
let capturedStats: TurnStats | undefined;
session.ask(q, {
  onStatus: (msg) => setStatus(msg),
  onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
  onComplete: (s) => { capturedStats = s; },
}).then(
  answer => {
    setTurns(t => [...t, { role: 'buffr', text: answer, stats: capturedStats }]);
    setBusy(false);
  },
  err => {
    setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]);
    setBusy(false);
  },
);
```

Walk it: `session.ask()` is called with three live callbacks — `onStatus`, `onTokens`, `onComplete`. The render is already showing the spinner. When the promise settles, exactly one of two branches runs (`.then` first arg = success, second arg = reject) — append the answer (with optional stats), or append the error. `setBusy(false)` appears in **both** branches. Note this is `.then(onFulfilled, onRejected)` not `try/catch/finally` — the two-argument `.then` is functionally equivalent to `try/catch` without a `finally`. The `setBusy(false)` duplication is intentional: both branches must reset the flag. The `capturedStats` closure is written by `onComplete` (fired at turn end) and read by whichever branch executes — even error turns carry timing data.

#### The render branch reads the flag — and shows live feedback

```tsx
// src/cli/chat.tsx:107, 126
{busy && <Spinner status={status} tokens={liveTokens} />}
// ...when not busy:
<textarea ref={taRef} placeholder="type your message…" … />
```

The flag the handler sets is the flag the view reads. `busy === true` mounts `<Spinner>`; `false` shows the input. The `<Spinner>` receives two live props: `status` (updated by `onStatus` callbacks — e.g. `"searching Google"`, `"fetching RSS feed"`) and `tokens` (accumulated by `onTokens` callbacks from `model_usage` events).

The spinner ticks independently of both:

```tsx
// src/cli/chat.tsx:22–46
function Spinner({ status, tokens }) {
  const startRef = useRef(Date.now());   // capture start time at mount
  useEffect(() => {
    startRef.current = Date.now();       // reset on each mount (each turn)
    const id = setInterval(() => {
      setFrame(f => (f+1) % FRAMES.length);
      setElapsedMs(Date.now() - startRef.current);  // tick every 100ms
    }, 100);
    return () => clearInterval(id);
  }, []);
  // renders: "⠹ searching Google · 3.2s · 1,204 tok"
}
```

Two moving parts: `elapsedMs` updates on a 100ms clock (always ticking); `tokens` is pushed by the backend's `onTokens` callbacks (only fires on model calls). They are independent — elapsed is always counting; tokens grow in discrete jumps when Gemma uses tokens. `useRef` for `startRef` is the right call: a `useState` would trigger a re-render when we capture the start time, and we don't want that.

### Move 2 variant — the load-bearing skeleton

Strip it to the irreducible core: **a boolean + a guard + a `finally` + a ticking spinner.** Four parts, named by what breaks:

- Drop the **guard** (`if (busy) return`) → concurrent turns; two `ask()` calls race into one conversation.
- Drop the **`finally`** (reset in `try` instead) → one thrown error wedges the UI on the spinner permanently.
- Drop the **render branch** on `busy` → no progress feedback; the UI looks frozen during a multi-second model call.
- Drop the **`useRef` start-time capture** (use `Date.now()` inline in the render instead) → `startRef` exists *because* you can't rely on a `useState` not causing a re-render at capture time; `useRef` mutates without triggering a re-render.

Optional hardening *not* present (and honestly so): no `AbortController` to cancel a slow turn, no timeout, no retry/backoff, no error-type discrimination. Those are the layers a production async machine adds on top of this skeleton.

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

**Update note — the flag now spans more shapes of "in flight," and one of them briefly shipped without an error branch.** `busy` no longer only guards a single `ask()` call: it also guards each round-trip of the `/research`/`/review` multi-turn flows (`06-multi-step-flow-as-state-machine.md`) and the live-updating `/research` progress panel (`07-streaming-progress-panel.md`). The mechanism is identical — one boolean, set before the hop, reset in both branches of `.then` — but it's now doing that job at up to nine call sites instead of one.

That repetition surfaced exactly the bug this file predicts. Commit `1344d9b` wired the `activeFlow` interceptor and the `/research`/`/review` start handlers with a **single-argument** `.then(result => …)` — no rejection handler — meaning a thrown error (a DB failure, an engine error) left `busy` stuck `true` forever, with no `finally`-equivalent to catch it. This is precisely the "what's the bug if you move `setBusy(false)` out of `finally`" interview question above, except it shipped as a real commit and needed a follow-up fix (`26f0e4b`) to convert all three call sites to the two-argument `.then(onSuccess, onError)` form the rest of the file already used. The lesson holds even sharper in hindsight: **there is no compiler check for a missing rejection handler on a `.then()` call** — it's pure code-review discipline, and it's the first thing to check when a new async call site is added to this file.

Read next: `04-session-as-the-data-layer.md` (what's behind the await), `02-hooks-state-in-a-cli.md` (`busy` among the state triad), and `06-multi-step-flow-as-state-machine.md` (the multi-turn shape this same flag now also guards). The suspend/resume at the `await` is `study-runtime-systems`; the wire timeout/retry semantics under `ask()` are `study-networking`.

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
- `06-multi-step-flow-as-state-machine.md` — the multi-turn shape `busy` now also guards, and the rejection-handling fix (`26f0e4b`) at those call sites
- `07-streaming-progress-panel.md` — `<ProgressPanel>`, the direct descendant of `<Spinner>`
- `audit.md` lens 4 (data-fetching), red flag #2 (rejection-handling as a pattern to watch), red flag #6 (no cancellation)
- cross-link: `study-runtime-systems` (suspend/resume at the await), `study-networking` (timeout/retry on the wire)

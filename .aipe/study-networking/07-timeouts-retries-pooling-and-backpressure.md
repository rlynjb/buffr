# 07 · Timeouts, Retries, Pooling, and Backpressure

> Connection pooling (`pg.Pool`) — present; timeouts/retries/backoff — absent
> · Industry standard · cancellation (`AbortSignal`) wired in aptkit, unused by buffr

## Zoom out, then zoom in

Verdict, blunt: **buffr pools, but it does not protect.** The one piece of
network-resilience machinery it has is the connection pool (`pg.Pool`) — and even
that runs on defaults. Timeouts, retries, backoff, jitter, request collapse,
backpressure: every one is `not yet exercised`. A hung Ollama request blocks the
turn forever; a transient DB blip throws straight to the UI. This file maps the
one mechanism that exists and names every gap with its exact attachment point.

```
  Zoom out — resilience lives (mostly) at the transport edges

  ┌─ UI layer (Ink) ────────────────────────────────────────────┐
  │  try { ask() } catch { show "error: …" }   ── ONE catch       │
  └───────┬──────────────────────────────────┬──────────────────┘
          │ pg-wire                            │ HTTP
          ▼                                    ▼
  ┌─ Pool (pg.Pool) ────────┐         ┌─ aptkit transport ───────┐
  │ ★ present, DEFAULT knobs │         │ AbortSignal accepted but │
  │   max 10, no timeouts    │         │ ★ buffr passes NONE      │
  └──────────────────────────┘         └───────────────────────────┘
```

Zoom in: this whole topic is about *what happens when the wire is slow or
failing.* buffr's answer is "the pool reuses sockets; everything else throws."

## Structure pass

**Layers.** UI (one try/catch) → Session (no retry wrapper) → Pool / Transport
(where timeouts and retries *would* live) → wire.

**Axis — trace `what happens on a slow or failed call?`**

```
  axis = "failure containment — where does a hung/failed call stop?"

  ┌─ pg-wire ─────────────────┐   ┌─ HTTP ────────────────────┐
  │ connect/query: no timeout  │   │ fetch: no timeout, no       │
  │ → waits on default behavior│   │   signal passed → hangs     │
  │ error → throws up          │   │ non-2xx → throws (no retry) │
  └────────────┬───────────────┘   └─────────────┬──────────────┘
               └──────────► both land in ◄────────┘
                       the Ink catch (chat.tsx:30)
                       → render "error: <message>", turn over
```

The containment point is identical for both paths: the single try/catch in the
Ink component. Nothing between the wire and that catch retries, times out, or
backs off.

**Seam.** The load-bearing seam is the `AbortSignal` slot in aptkit's transport —
a boundary that's *built for* cancellation but where buffr passes nothing through.
The contract exists; buffr declines it.

## How it works

### Move 1 — the mental model

Picture the difference between `fetch(url)` and `fetch(url, { signal:
AbortSignal.timeout(5000) })`. The first hangs as long as the server makes it; the
second gives up after 5 seconds. buffr is the first one — on *every* call. The
only resilience primitive it actually uses is the pool, whose kernel you already
saw in `03`: warm sockets, borrow/return, a `max` cap.

```
  Pattern — what buffr HAS vs what it's MISSING

   HAS:    ┌─ pool ─┐ warm sockets, borrow/return, max 10
           └────────┘ (amortizes handshake — a perf win)

   MISSING (each throws/hangs instead):
     timeout   — no AbortSignal, no connectionTimeoutMillis
     retry     — one attempt, then throw
     backoff   — n/a (no retry to space out)
     jitter    — n/a
     collapse  — duplicate concurrent queries not deduped
     backpressure — no queue bound beyond pool max
```

### Move 2 — the walkthrough

**The pool exists, on defaults.** From `03`, the construction is one line
(`src/db.ts:4`):

```ts
return new pg.Pool({ connectionString: databaseUrl });
```

No options object means node-postgres defaults: `max: 10` connections, no
`connectionTimeoutMillis` (a `pool.connect()` against an unreachable DB waits on
the OS TCP timeout — tens of seconds), no `idleTimeoutMillis` override (idle
sockets stay open), no `statement_timeout`. For a single-user CLI this is mostly
harmless — you'll never approach 10 concurrent connections — but the *connect
timeout* gap is real: point `DATABASE_URL` at a dead host and startup hangs on the
TCP handshake with no fast failure.

**Cancellation is wired in the transport, and buffr never uses it.** This is the
sharpest gap. aptkit's transport explicitly supports an `AbortSignal`:

```js
// aptkit defaultHttpTransport
return async ({ signal, ...payload }) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),   // ── honors a signal IF given
  });
```

and the provider calls `request.signal?.throwIfAborted()` before dispatch. The
machinery is there. But buffr's call site passes nothing (`src/session.ts:62`):

```ts
const answer = await agent.answer(question);   // no signal, no timeout, no deadline
```

So a wedged Ollama (model loading, OOM, stuck) leaves the `fetch` open
indefinitely. The Ink spinner spins forever; there's no deadline to trip. The fix
is small and the seam is named: thread an `AbortSignal.timeout(ms)` from `ask`
into `agent.answer` (an aptkit signature it already accepts).

**Retries: one attempt, then throw.** Walk the failure path end to end:

```
  Layers-and-hops — a failed model call, no retry

  ┌─ Ollama ──────────────┐
  │ 503 (overloaded) or    │
  │ connection refused      │
  └──────────┬──────────────┘
             │ hop 1: res.ok false → throw `ollama HTTP 503`
             ▼
  ┌─ aptkit transport ────┐  (no retry here)
  └──────────┬─────────────┘
             │ hop 2: rejection propagates up through agent.answer
             ▼
  ┌─ session.ask ─────────┐  (no retry wrapper)
  └──────────┬─────────────┘
             │ hop 3: rejection
             ▼
  ┌─ Ink catch (chat.tsx:30) ─┐
  │ setTurns(… "error: 503")   │  ← turn over, user re-types to retry
  └────────────────────────────┘
```

The only "retry" is the human re-typing the question. No exponential backoff, no
jitter, no retry budget. For a transient 503 (Ollama swapping a model in), an
automatic single retry with a short backoff would silently recover most blips —
but it's not there. This is `not yet exercised`.

**Backpressure and request collapse: not exercised, and barely relevant today.**
The Ink UI guards against concurrent turns with `if (busy) return`
(`src/cli/chat.tsx:17`) — so a single user can't fire two overlapping `ask` calls.
That's a UI-level serialization, not network backpressure, but it means buffr never
generates the load that would *need* backpressure. There's no request queue, no
in-flight dedupe (two identical embeds would both hit `/api/embed`), no concurrency
limiter. With one user and a serialized UI, none of that bites — it'd matter the
moment buffr served multiple callers or fired parallel embeds.

**The one place a failure is deliberately swallowed.** Memory writes are
best-effort (`src/session.ts:65-69`):

```ts
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

This is the *correct* shape of "don't let a non-critical network write lose the
answer the user already has." It's not a retry — it's a deliberate
fail-and-continue. Worth naming because it's the one place buffr makes an explicit
network-failure *decision* rather than letting the error throw.

### Move 2.5 — current vs future

Phase A (now): pool on defaults; no timeouts, retries, or backoff; one human-driven
retry path; memory writes fail-open.

Phase B (hardening): add `connectionTimeoutMillis` to the pool, thread an
`AbortSignal.timeout` into `agent.answer`, wrap the model call in a single retry
with jittered backoff for 503/connection-refused, and bound the pool with explicit
`max`. What *doesn't* change: the pool *pattern* is already right — it's the knobs
that are unset. None of this requires restructuring; it's additive at named seams.

### Move 3 — the principle

Pooling is the resilience primitive you keep; timeouts and bounded retries are the
ones you add the moment a dependency can be slow or flaky. buffr correctly has the
first and correctly *defers* the rest for a single-device, single-user CLI where
the model is on the same box and a hang is the user's own machine. The honest read:
this is fine *now*, and the exact seams to harden it (the `AbortSignal` slot, the
pool options object, a retry wrapper around `agent.answer`) are all named and
small.

## Primary diagram

```
  buffr timeouts/retries/pooling — recap

  PRESENT:
    connection pool (pg.Pool)  ── src/db.ts:4, src/session.ts:39
      warm sockets, borrow/return, default max 10
    best-effort memory write (fail-open)  ── src/session.ts:65-69
    UI concurrency guard `if (busy) return`  ── src/cli/chat.tsx:17

  NOT YET EXERCISED (seam where each attaches):
    HTTP timeout    → AbortSignal slot in aptkit transport (buffr passes none)
    pg connect timeout → connectionTimeoutMillis on pg.Pool (unset)
    retry / backoff / jitter → wrapper around agent.answer (absent)
    request collapse / dedupe → none (two identical embeds both fire)
    backpressure / queue bound → only pool max + UI busy-guard
```

## Elaborate

The timeout/retry/backoff/jitter stack is the standard defense against a slow or
flapping dependency, and the order matters: a timeout without a retry just fails
faster; a retry without backoff hammers a struggling server; backoff without
jitter synchronizes a thundering herd. buffr has none of the stack because its
dependencies are local and its concurrency is one — so the absence is a deferred
cost, not a bug. The single most valuable add is the timeout: an `AbortSignal`
threaded into `agent.answer` turns "spinner forever" into "fails in N seconds,"
and the slot is already there in aptkit.

## Interview defense

**Q: What resilience does buffr have on the wire?**

```
  HAS:  pool (warm sockets, max 10) + best-effort memory write
  LACKS: timeout · retry · backoff · jitter · collapse · backpressure
```

Answer: "One thing — the connection pool, on defaults. Everything else is absent.
No HTTP timeout (the `AbortSignal` slot in aptkit's transport exists but buffr
passes nothing — `src/session.ts:62`), no pg connect timeout, no retry or backoff.
A hung Ollama spins forever; a transient failure throws to the Ink catch. For a
single-user local CLI that's a defensible deferral, and the seams to fix it are all
named and small."

**Q: What's the single highest-leverage thing to add?**

Answer: "A request timeout. Thread `AbortSignal.timeout(ms)` from `ask` into
`agent.answer` — the transport already honors `signal`. That converts the worst
failure mode, an indefinitely-hung model call, into a bounded, recoverable error."

**Q: Why does the memory write swallow its error?**

Answer: "Deliberate fail-open. The answer is already in the user's hands; a memory
embed/upsert failure shouldn't lose it (`src/session.ts:65-69`). It's the one place
buffr makes an explicit network-failure decision rather than throwing."

## See also

- `03-tcp-udp-connections-and-sockets.md` — the pool mechanism this builds on
- `05-http-semantics-caching-and-cors.md` — the non-2xx throw that has no retry
- `06-websockets-sse-streaming-and-realtime.md` — why a long generation has nothing to interrupt it
- `08-networking-red-flags-audit.md` — these gaps ranked by consequence

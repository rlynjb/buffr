# 07 · Timeouts, Retries, Pooling, and Backpressure

> Connection pooling (`pg.Pool`) and concurrent fan-out — present; per-request timeouts/retries/backoff — absent
> · Industry standard · cancellation (`AbortSignal`) wired at every layer, used at none

## Zoom out, then zoom in

Verdict, blunt, and slightly less bleak than last pass: **buffr now has three
resilience mechanisms, and still zero timeouts.** The connection pool
(`pg.Pool`) is joined by two new primitives — a concurrent fan-out that
tolerates individual connector failures (`Collector.execute`), and a bounded
pool teardown on exit. But the one gap that mattered most before still
matters most now, and it got *wider*: nothing threads an `AbortSignal`
anywhere, and that now applies to six external APIs firing at once, not just
one loopback model call. A hung Ollama request blocks a turn forever; a single
hung connector — among six running concurrently — blocks the whole
`/research` or `/investing` turn forever, even after the other five already
succeeded. This file maps what exists now and names every remaining gap with
its exact attachment point.

```
  Zoom out — resilience lives at three points, timeouts live at none

  ┌─ UI layer (OpenTUI) ──────────────────────────────────────────────┐
  │  .then(answer => …, err => show "error: …")  ── same shape, ONE     │
  │  per flow (ask / research / investing / review)                     │
  └───────┬──────────────────────────┬─────────────────────┬──────────┘
          │ pg-wire                   │ HTTP (Ollama)        │ HTTPS × 6 (connectors)
          ▼                           ▼                       ▼
  ┌─ Pool (pg.Pool) ────────┐ ┌─ aptkit transport ──────┐ ┌─ Collector.execute ───────┐
  │ ★ present, DEFAULT knobs │ │ AbortSignal accepted    │ │ ★ Promise.all + try/catch ★│
  │   max 10, no timeouts    │ │ but buffr passes NONE   │ │ per-source failure caught, │
  │ ★ bounded teardown NEW ★ │ │                          │ │ NO per-source timeout      │
  └──────────────────────────┘ └────────────────────────────┘ └──────────────────────────────┘
```

Zoom in: this whole topic is about *what happens when the wire is slow or
failing.* buffr's answer used to be "the pool reuses sockets; everything else
throws." It's now "the pool reuses sockets and drains on a deadline; the
connector fan-out survives individual failures; nothing anywhere gives up on a
call that just hangs."

## Structure pass

**Layers.** UI (one error handler per flow — ask / research / investing /
review, all the same `.then(ok, err)` shape) → Session (no retry wrapper) →
Pool / Transport / Collector (where timeouts and retries *would* live) → wire.

**Axis — trace `what happens on a slow or failed call?`**

```
  axis = "failure containment — where does a hung/failed call stop?"

  ┌─ pg-wire ──────────────┐ ┌─ HTTP (Ollama) ─────────┐ ┌─ HTTPS (6 connectors) ───────┐
  │ connect/query: no       │ │ fetch: no timeout, no    │ │ Promise.all catches a THROW   │
  │  timeout → waits on      │ │  signal passed → hangs   │ │ per source — but a HANG on    │
  │  default behavior        │ │ non-2xx → throws          │ │ any ONE source blocks the      │
  │ error → throws up        │ │  (no retry)                │ │ whole batch, forever           │
  └────────────┬─────────────┘ └─────────────┬──────────────┘ └───────────────┬────────────────┘
               └──────────────────► both land in ◄────────────────────────────┘
                       the OpenTUI catch (chat.tsx)
                       → render "error: <message>", turn over
                       (a HANG never reaches this catch at all — nothing to show)
```

The containment point is identical in *shape* for a *thrown* failure on any of
the three paths: whichever flow is active (`ask`/`researchEvaluate`/`analyze`/
`review`) resolves its promise chain with the same `(answer => setTurns(...),
err => setTurns(..., 'error: ...'))` pair (`src/cli/chat.tsx`, e.g. lines
367-376 for the plain-ask flow). It's one pattern repeated per flow, not
literally one `try/catch` block anymore. But a *hang* on the connector path is
strictly worse than a hang on the Ollama path used to be — it now silently
absorbs five successful results along with it, because `Promise.all` requires
every promise to settle before any of them are returned to the caller.

**Seam.** The load-bearing seam is the `AbortSignal`/`FetchOptions.signal` slot
— present at *every* layer now (aptkit's transport, and
`packages/connectors/src/contracts.ts:15`'s `FetchOptions`), and honored by
*none* of buffr's call sites. The contract exists, twice over; buffr declines
it, twice over.

## How it works

### Move 1 — the mental model

Picture the difference between `fetch(url)` and `fetch(url, { signal:
AbortSignal.timeout(5000) })`. The first hangs as long as the server makes it; the
second gives up after 5 seconds. buffr is the first one — on *every* call,
including all six connectors. Three resilience primitives exist now: the pool
(warm sockets, borrow/return, a `max` cap — the kernel you already saw in
`03`), the pool's bounded teardown (also `03`), and the connector fan-out's
partial-failure tolerance (new this pass). None of the three is a timeout, and
timeout is still the one piece missing everywhere it would matter most.

```
  Pattern — what buffr HAS vs what it's MISSING

   HAS:    ┌─ pool ──────┐ warm sockets, borrow/return, max 10
           └──────────────┘ (amortizes handshake — a perf win)

           ┌─ bounded teardown ─┐ pool.end() raced against 1s;
           └──────────────────────┘ hard 1.5s process-exit deadline (03)

           ┌─ fan-out tolerance ─┐ Promise.all + per-source try/catch;
           └────────────────────────┘ one connector THROWING doesn't sink the batch

   MISSING (each throws/hangs instead):
     timeout       — no AbortSignal anywhere: not on Ollama, not on any connector
     retry         — one attempt, then throw
     backoff       — n/a (no retry to space out)
     jitter        — n/a
     collapse      — duplicate CONCURRENT calls not deduped (sequential calls ARE,
                     via the 1h TTL CachedConnector — see below)
     backpressure  — no queue bound beyond pool max
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
machinery is there. But buffr's call site passes nothing (`src/session.ts:675`):

```ts
const answer = await agent.answer(question);   // no signal, no timeout, no deadline
```

So a wedged Ollama (model loading, OOM, stuck) leaves the `fetch` open
indefinitely. The `ProgressPanel` (`src/cli/chat.tsx:431`) stays up forever; there's no deadline to trip. The fix
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
  ┌─ OpenTUI catch (chat.tsx (per-flow error handler)) ─┐
  │ setTurns(… "error: 503")   │  ← turn over, user re-types to retry
  └────────────────────────────┘
```

The only "retry" is the human re-typing the question. No exponential backoff, no
jitter, no retry budget. For a transient 503 (Ollama swapping a model in), an
automatic single retry with a short backoff would silently recover most blips —
but it's not there. This is `not yet exercised`.

**Backpressure and request collapse: not exercised, and barely relevant today.**
The OpenTUI UI guards against concurrent turns with `if (busy) return`
(`src/cli/chat.tsx:156`) — so a single user can't fire two overlapping `ask` calls.
That's a UI-level serialization, not network backpressure, but it means buffr never
generates the load that would *need* backpressure. There's no request queue, no
in-flight dedupe (two identical embeds would both hit `/api/embed`), no concurrency
limiter. With one user and a serialized UI, none of that bites — it'd matter the
moment buffr served multiple callers or fired parallel embeds.

**The one place a failure is deliberately swallowed.** Memory writes are
best-effort (`src/session.ts:686-690`):

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

**New this pass: concurrent fan-out with partial-failure tolerance.**
`Collector.execute` is the mechanism behind every `/research` and `/investing`
turn (`packages/capabilities/src/collector/index.ts:35-52`):

```ts
await Promise.all(
  input.sources.map(async (source) => {
    onEvent?.({ type: 'start', sourceId: source.connector.id });
    try {
      const result = await source.connector.fetch(source.params);   // ── no signal passed
      evidence.push(...result.toEvidence());
      onEvent?.({ type: 'done', sourceId: source.connector.id, count: evidence.length });
    } catch (err) {
      failed.push({ sourceId: source.connector.id, reason: String(err) });   // ── caught, not rethrown
      onEvent?.({ type: 'failed', sourceId: source.connector.id, … });
    }
  }),
);
```

Read the shape carefully, because it has a real strength and a real gap that
look similar at first glance but aren't. **The strength:** each source's
`fetch` is wrapped in its own `try/catch` *inside* the `Promise.all` mapper —
so a rejection (Google 429, Reddit connection-refused, a malformed body
crashing `res.json()`) is caught right there and turned into a `failed[]`
entry. The other five connectors' promises are unaffected; `Promise.all`
still resolves once every mapped function returns. This is a real
resilience upgrade over the plain-chat path: five connectors succeeding and
one failing produces a research digest with five sources instead of a crashed
turn. **The gap:** `Promise.all` only resolves once *every* promise settles —
resolved or rejected. A connector whose `fetch()` never settles at all (TCP
connect succeeds, server never responds, no timeout to give up) leaves its
mapped async function permanently pending. `Promise.all` waits on it forever.
The other five connectors' results — already sitting in memory, already
pushed into `evidence` — are never returned to the caller, because the batch
as a whole never resolves. **The fault-tolerance here is a rejection handler,
not a timeout — it protects against a connector that fails loud, not one that
fails silent.**

```
  Pattern — Promise.all tolerates throws, not hangs

   5 fast connectors + 1 hung connector:

   Reddit    ──done──┐
   Google    ──done──┤
   Brave     ──done──┤
   Tavily    ──done──┼──► Promise.all waits for ALL SIX
   RSS       ──done──┤       ↑
   Trends    ──??????─┘   still pending, no timeout, no signal

   result: the turn NEVER completes — not even with 5/6 evidence already collected
```

`MarketResearchEngine.run()` at the InvestingEngine call site and
`MarketResearchEngine.collect()` both inherit this exactly, since both sit on
top of the same `Collector.execute`. → `08` ranks this as the top risk.

**Also new: connector-level caching, which is a real (if partial) answer to
request collapse.** Every connector is wrapped in `CachedConnector` before
it's wired into a source list (`src/session.ts`, e.g. line 468):

```ts
const redditConnector = new CachedConnector(new RedditSearchConnector(), new InMemoryCache(), CONNECTOR_CACHE_TTL_MS);
// CONNECTOR_CACHE_TTL_MS = 60 * 60 * 1000  — one hour
```

`CachedConnector.fetch` (`packages/connectors/src/cached-connector.ts:21-28`)
keys on `JSON.stringify(params)` and returns a cached `ConnectorResult`
without hitting the network if the same params were fetched within the last
hour. That's real network-load reduction — running `/research` twice on the
same topic within an hour costs one round of six connector calls, not two.
It does **not** solve concurrent-request collapse: two `/research` calls
fired at the same instant, before either's first fetch has resolved and been
cached, both go to the network. The gap named in the last pass ("no request
collapse / embed dedupe") is now half-true instead of fully true — sequential
duplicate work is caught; simultaneous duplicate work isn't.

### Move 2.5 — current vs future

Phase A (now): pool on defaults, with a bounded teardown; connector fan-out
tolerates thrown failures; a 1h TTL cache cuts repeat network calls; no
timeout anywhere; one human-driven retry path; memory writes fail-open.

Phase B (hardening): add `connectionTimeoutMillis` to the pool, thread an
`AbortSignal.timeout` into `agent.answer` *and* into every
`source.connector.fetch(source.params, { signal })` call inside
`Collector.execute`, wrap the model call and the connector calls in a single
retry with jittered backoff for 503/connection-refused (skipping 429 — see
`08`), and bound the pool with explicit `max`. What *doesn't* change: the pool
*pattern* and the fan-out *pattern* are already right — it's the same missing
knob (a signal, a deadline) showing up at two call sites instead of one. None
of this requires restructuring; it's additive at named seams, and the seam for
the connector path is one line: pass `opts` through in `Collector.execute`'s
`source.connector.fetch(source.params)` call.

### Move 3 — the principle

Pooling and fan-out tolerance are the resilience primitives you keep; timeouts
and bounded retries are the ones you add the moment a dependency can be slow
or flaky — and "flaky" now includes six real internet APIs, not just a local
model server. buffr correctly has the pool and correctly added fan-out
tolerance for the connectors, but it's the same principle both times: a
mechanism that survives a *loud* failure (a thrown error, a rejected promise)
is necessary but not sufficient. The mechanism that survives a *silent* one —
a hang, a connection that never completes — is a timeout, and it's the one
primitive still missing at every single call site in the repo. The honest
read: this was a defensible deferral when the only wire call was to a
same-box model server; it's a sharper gap now that six concurrent connectors
share the exact same unprotected shape.

## Primary diagram

```
  buffr timeouts/retries/pooling — recap

  PRESENT:
    connection pool (pg.Pool)  ── src/db.ts:4, src/session.ts:399
      warm sockets, borrow/return, default max 10
    bounded pool teardown (NEW)  ── src/session.ts close(), src/cli/chat.tsx forceExit()
      pool.end() raced against 1s; hard 1.5s process-exit deadline
    connector fan-out, partial-failure tolerance (NEW)  ── packages/capabilities/src/collector/index.ts:35-52
      Promise.all + per-source try/catch — survives THROWS, not HANGS
    1h TTL connector cache (NEW)  ── packages/connectors/src/cached-connector.ts
      cuts repeat sequential calls; does NOT dedupe concurrent identical calls
    best-effort memory write (fail-open)  ── src/session.ts
    UI concurrency guard `if (busy) return`  ── src/cli/chat.tsx

  NOT YET EXERCISED (seam where each attaches):
    HTTP timeout (Ollama)     → AbortSignal slot in aptkit transport (buffr passes none)
    HTTP timeout (connectors) → FetchOptions.signal on EVERY connector (buffr passes none)
    pg connect timeout        → connectionTimeoutMillis on pg.Pool (unset)
    retry / backoff / jitter  → wrapper around agent.answer AND Collector.execute (absent)
    request collapse (concurrent) → CachedConnector only catches SEQUENTIAL duplicates
    backpressure / queue bound → only pool max + UI busy-guard
```

## Elaborate

The timeout/retry/backoff/jitter stack is the standard defense against a slow or
flapping dependency, and the order matters: a timeout without a retry just fails
faster; a retry without backoff hammers a struggling server; backoff without
jitter synchronizes a thundering herd. buffr still has none of that stack, but
it now has two of the *other* standard defenses — bounded fan-out (tolerate a
failed peer without failing the batch) and a bounded teardown (never let a
resource release hang the process) — which shipped independently of the
timeout work and are worth recognizing as real, separate wins rather than
lumping "no resilience" into one bucket. The single most valuable add is still
the timeout, and it's now a two-line fix, not a one-line fix: thread an
`AbortSignal` into `agent.answer`, and thread `opts` through
`Collector.execute`'s `source.connector.fetch(source.params)` call so each
connector can receive one too.

## Interview defense

**Q: What resilience does buffr have on the wire?**

```
  HAS:  pool + bounded teardown + fan-out failure tolerance + 1h TTL cache
  LACKS: timeout (anywhere) · retry · backoff · jitter · concurrent-request collapse
```

Answer: "Four things now, not one. The connection pool, on defaults. A bounded
teardown — `pool.end()` raced against a timeout so a wedged connection can't
hang `/exit`. A concurrent fan-out for `/research`/`/investing` that tolerates
any one of six connectors *throwing* without losing the others. And a 1-hour
cache that stops repeat identical connector calls. What's still missing is the
same gap as before, just wider: no timeout, anywhere — not the model call, not
any of the six connectors. `Promise.all` in the fan-out only protects against
a connector that fails loud; one that hangs blocks the whole turn forever,
even after the other five already succeeded."

**Q: What's the single highest-leverage thing to add?**

Answer: "A request timeout, threaded to two places instead of one now. Thread
`AbortSignal.timeout(ms)` from `ask` into `agent.answer` for the model path,
and thread the same kind of signal through `Collector.execute`'s
`source.connector.fetch(source.params, opts)` call for the connector path —
every connector already accepts a `FetchOptions.signal`, nobody supplies it.
That second one is now the more consequential fix, because it's the one
protecting against a batch of six concurrent calls instead of one."

**Q: Walk me through what happens if one of the six /research connectors hangs.**

Answer: "The other five still run their `fetch()`s and get caught in their own
`try/catch` inside `Collector.execute`'s `Promise.all` — but `Promise.all`
doesn't resolve until every mapped promise settles, and a hung `fetch()` never
settles. So the whole `/research` turn just never completes, even though five
sixths of the evidence is already sitting in memory. The UI shows a spinner
forever, identical to the old single-connector Ollama gap, just triggered by a
different one of six possible connectors instead of one."

**Q: Why does the memory write swallow its error?**

Answer: "Deliberate fail-open. The answer is already in the user's hands; a memory
embed/upsert failure shouldn't lose it. It's the one place buffr makes an explicit
network-failure decision rather than throwing."

## See also

- `03-tcp-udp-connections-and-sockets.md` — the pool mechanism and its new bounded teardown
- `05-http-semantics-caching-and-cors.md` — the non-2xx throw that has no retry, and the connectors' body-parse gaps
- `06-websockets-sse-streaming-and-realtime.md` — why a long generation has nothing to interrupt it
- `08-networking-red-flags-audit.md` — these gaps ranked by consequence

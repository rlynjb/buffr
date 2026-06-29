# Timeouts, Retries, Pooling, and Backpressure

**Industry name(s):** resilience patterns / connection pooling / overload
control. **Type:** Industry standard.

## Zoom out, then zoom in

Of the five resilience mechanisms in this file's title, buffr exercises
**one** — pooling (well) — and the rest are `not yet exercised`. No
timeouts, no retries, no backoff/jitter, no `AbortSignal`, no pool tuning,
no explicit backpressure. The only overload control is accidental: the
`busy` flag in the UI that blocks a second turn while one is running.
This is the file where the honest absences are the lesson, ranked by how
much they'd bite.

```
  Zoom out — resilience surface, present vs absent

  ┌─ UI (chat.tsx) ──────────────────────────────────────────┐
  │  busy flag = the ONLY overload control (one turn at a time)│ ← present
  │  try/catch = the ONLY failure handling (render the error) │   (barely)
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Orchestration (session.ts) ▼────────────────────────────┐
  │  pool = createPool(databaseUrl)  ← POOLING (present, good)│ ← present
  │  NO timeout · NO retry · NO AbortSignal around any call  │ ← absent
  └─────────────────────────────┬─────────────────────────────┘
                                │
  ┌─ Transport (pg / aptkit) ────▼───────────────────────────┐
  │  pool defaults untuned · no per-request deadline          │ ← absent
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is **resilience under a slow or failing peer**:
timeouts bound how long you wait, retries recover from transient failure,
backoff/jitter keep retries from stampeding, pooling reuses connections,
backpressure stops you from piling on work faster than it drains. buffr
has the pool; it has none of the bounding or recovery.

## Structure pass

**Layers.** UI (busy flag, try/catch) → orchestration (the pool, the bare
awaits) → transport (untuned pg defaults).

**Axis — failure / "what happens when a peer is slow or down?"** Trace it:

```
  axis: "peer is slow or down — what happens?"

  ┌─ UI (chat.tsx) ────────────┐  → spinner spins FOREVER (no timeout);
  │                            │     if it throws, render error, stay up
  └────────────────────────────┘
  ┌─ orchestration ────────────┐  → await blocks indefinitely; no retry
  └────────────────────────────┘
  ┌─ transport ────────────────┐  → pg default connect timeout only;
  │                            │     query has no deadline
  └────────────────────────────┘

  the failure answer is "wait forever" until an error is THROWN
```

**Seam.** Every network call in buffr is a *bare* `await` — no wrapper, no
deadline, no retry shell around it. The seam where a timeout/retry policy
*would* live (a wrapper between the app and the call) doesn't exist. The
only real seam is `pool.connect()/query()`, which gives pooling but imposes
no time bound.

## How it works

### Move 1 — the mental model

You know the difference between `await fetch(url)` and
`await fetch(url, { signal: AbortSignal.timeout(5000) })`. The first waits
as long as the server takes — forever, if it hangs. The second gives up
after 5s. buffr is *entirely* the first kind. Every network await is naked:
no signal, no deadline, no retry. The mental model is "happy path only, and
trust the peer to either answer or throw."

```
  The bare-await kernel — what buffr does at every call

   await <network call>          ← no signal, no timeout, no retry
      ├─ resolves → continue
      ├─ throws  → bubble to chat.tsx:30 try/catch → render error
      └─ HANGS   → ★ wait forever, spinner spins ★  (no escape)
```

### Move 2 — walk the five mechanisms

**Pooling — present, and done right.** The one mechanism buffr exercises.
`src/session.ts:39` builds one `pg.Pool` for the whole session; reads
borrow/return via `pool.query()`, the transactional write leases and
releases explicitly (`pg-vector-store.ts` `upsert()`, with
`client.release()` in `finally`). File `03` walks this in full. Verdict:
the pool is correct and is the right call for a long-lived session.

**Pool tuning — absent.** Look again at `src/db.ts:4-6`:

```
  src/db.ts:4-6 — every pool knob is a default

  new pg.Pool({ connectionString: databaseUrl });
  //  NOT set: max (default 10 connections)
  //  NOT set: idleTimeoutMillis (default 10s)
  //  NOT set: connectionTimeoutMillis (default 0 = wait forever
  //           for a free connection if all 10 are busy)
```

`connectionTimeoutMillis: 0` is the sharp one: if all pooled connections
are busy or unreachable, `pool.connect()` waits *forever* for one to free
up. For a single-user CLI doing one turn at a time, the default `max: 10`
is plenty and you'll never exhaust it — so this is a *latent* gap, not a
live bug. It becomes real the instant concurrency rises. `not yet
exercised`: any pool tuning.

**Timeouts — absent everywhere.** No statement timeout on the pg side, no
`AbortSignal` on the Ollama side. The query in `pg-vector-store.search()`
and the `agent.answer()` call in `session.ts:62` are both bare awaits. If
Postgres hangs mid-query or Ollama stalls mid-generation, the turn never
completes and the Ink spinner (file `06`) spins indefinitely with no way
out but killing the process. This is the single most impactful absence,
because the default UX failure mode is *silent infinite wait*, not a
visible error.

```
  Timeout absence — the hang has no floor

  ┌─ chat.tsx ──┐ busy=true   ┌─ session.ask ─┐  bare await  ┌─ peer ─┐
  │ <Spinner/>  │ ──────────► │ agent.answer()│ ───────────► │ hangs… │
  │ thinking…   │             │ (no signal)   │              │  ⏳∞    │
  │   ⏳ forever │ ◄────────── │ never resolves│ ◄─────────── │  never │
  └─────────────┘  no timeout  └───────────────┘   no deadline└────────┘

  there is no arrow that fires on "too slow" — only on "threw" or "done"
```

**Retries — absent.** No retry on a transient pg disconnect, no retry on
an Ollama 503 or a dropped HTTP connection. A single transient blip fails
the whole turn — it surfaces as `error: <message>` at `chat.tsx:30`, and
recovery is the user manually retyping the question. There is no automatic
retry anywhere in buffr. `not yet exercised`: retries.

**Backoff / jitter — absent, and correctly downstream of retries.**
Backoff and jitter exist to space out *retries* so they don't stampede a
recovering peer. With no retries, there's nothing to back off. `not yet
exercised` — and adding backoff before adding retries would be
cart-before-horse.

**Backpressure / request collapsing — one accidental guard.** The only
overload control is the `busy` flag, `src/cli/chat.tsx:13`:

```
  chat.tsx:15-16,32 — the busy flag, buffr's whole backpressure

  const onSubmit = async (value) => {
    if (busy) return;            // ← drop the submit if a turn is running
    ...
    setBusy(true);
    try { ... } finally { setBusy(false); }  // released when turn ends
  };
```

This serializes turns: while one `ask()` is in flight, a second submit is
dropped on the floor. It's not a designed backpressure mechanism — it's a
UI guard that happens to bound concurrency to 1. For a single human typing
one question at a time it's exactly enough; there's no queue to overflow,
no fan-out to collapse, no concurrent load to shed. *What breaks if
removed:* overlapping turns racing on the same conversation/pool — but
since it's there, that never happens. `not yet exercised`: real
backpressure (queues, load shedding, request collapsing) — and not needed
at single-user scale.

### Move 3 — the principle

**Pooling is the resilience mechanism that pays off even at single-user
scale; timeouts and retries are the ones whose absence is survivable only
because the peers are local.** buffr correctly invested in the pool and
correctly skipped the rest — for now — because loopback Ollama and a local
Postgres don't hang or flap the way a remote service does. The judgment to
internalize: *the moment a peer moves off-box (remote `DATABASE_URL`,
remote `OLLAMA_HOST`), the missing timeout becomes the highest-priority
bug,* because "wait forever" stops being a rare local edge case and becomes
a routine network reality.

## Primary diagram

The full resilience picture — one present, the rest absent and ranked.

```
  Resilience — present (pool) vs absent (everything else)

  ┌─ chat.tsx (UI) ──────────────────────────────────────────┐
  │  busy flag → serialize turns (accidental backpressure) ✓  │
  │  try/catch → render error, keep session alive          ✓  │
  │  NO timeout on the spinner → hang = spin forever       ✗  │
  └─────────────────────────────┬─────────────────────────────┘
  ┌─ session.ts / db.ts ────────▼────────────────────────────┐
  │  pg.Pool (warm, correct)                               ✓  │
  │  pool tuning (max/idle/connectTimeout) = defaults      ✗  │
  │  per-call timeout / AbortSignal                        ✗  │
  │  retries · backoff · jitter                            ✗  │
  └──────────────────────────────────────────────────────────┘

  rank of absences by bite:  1) timeouts  2) retries
  3) pool tuning (latent)  4) backoff (downstream of retries)
```

## Elaborate

The reason this is defensible *today* and dangerous *tomorrow* is entirely
about where the peers live. File `02` established the default addressing is
loopback (Ollama) and likely-local Postgres. Loopback doesn't drop
packets, doesn't flap routes, doesn't impose DNS latency — so "wait
forever" almost never triggers, and a retry would have nothing transient to
recover from. That's why skipping timeouts/retries was a reasonable call at
build time. But the project context names Supabase as the persistence
target, i.e. a *remote* Postgres. The instant `DATABASE_URL` points
off-box, every absence in this file flips from latent to live: timeouts
become mandatory (networks hang), retries become valuable (networks blip),
pool tuning matters (`connectionTimeoutMillis: 0` will eventually bite).
The mechanisms aren't wrong to be absent — they're *staged*, and the
trigger to add them is "a peer left the box."

## Interview defense

**Q: "What happens if Postgres or Ollama hangs mid-request?"**

> The turn hangs forever. Every network call is a bare `await` with no
> timeout and no `AbortSignal` — `agent.answer()` at `session.ts:62`, the
> query in `pg-vector-store.search()`. The Ink spinner just keeps spinning;
> the only escape is killing the process. That's the single biggest gap,
> because the failure mode is a silent infinite wait, not a visible error.
> The fix is a per-call deadline — `AbortSignal.timeout` on the Ollama side,
> a statement timeout on the pg side.

```
  bare await → resolves | throws | HANGS (no timeout arrow)
  hang → spinner spins ∞ → kill process is the only exit
```

Anchor: *"No `AbortSignal`, no statement timeout anywhere — `session.ts:62`
is a naked await."*

**Q: "How does it handle a transient network blip?"**

> It doesn't retry — one blip fails the turn, surfaces as `error: …` at
> `chat.tsx:30`, and the user retypes. No retry, so no backoff/jitter
> either (nothing to space out). Survivable now because the peers are
> local; the day `DATABASE_URL` goes remote, retries become worth adding —
> with backoff, in that order.

Anchor: *"`chat.tsx:30` catch is the whole recovery story; retries are
`not yet exercised`."*

**Q: "Is there any backpressure?"**

> One accidental guard: the `busy` flag at `chat.tsx:13` drops a second
> submit while a turn runs, so concurrency is bounded to 1. It's a UI guard,
> not designed backpressure — but at single-user scale it's exactly enough.
> No queue, no load shedding, no request collapsing, and none needed yet.

Anchor: *"`if (busy) return;` at `chat.tsx:16` — concurrency capped at one
turn."*

## See also

- `03-tcp-udp-connections-and-sockets.md` — the pool itself (the one
  present mechanism) in full.
- `06-websockets-sse-streaming-and-realtime.md` — the spinner that has no
  timeout behind it.
- `08-networking-red-flags-audit.md` — these absences ranked as risks with
  evidence.
- `study-debugging-observability` — how an infinite hang would (or
  wouldn't) surface.

# 08 · Networking Red-Flags Audit

> Ranked protocol and network-failure risks, grounded in the repo — Project-specific
> · verdict-first: what would actually hurt, in order

## Zoom out, then zoom in

This is the file that ranks the wire-level risks by *consequence*, not by
template. The headline verdict: buffr's networking is small and mostly correct
for what it is — a single-device, single-user CLI — and its risks are almost
entirely *missing resilience*, not *broken behavior*. Nothing here is a bug that
fires today; everything is a gap that bites the moment a dependency slows, fails,
or moves off-box.

```
  Zoom out — where the red flags live on the map

  ┌─ Process ───────────────────────────────────────────────────┐
  │  session.ask()  ── no timeout, no retry around agent.answer  │ ◄ R1, R2
  └───────┬──────────────────────────────────┬──────────────────┘
          │ pg-wire                            │ HTTP
          ▼                                    ▼
  ┌─ Pool ──────────────────┐         ┌─ aptkit transport ───────┐
  │ default knobs (R3)      │         │ AbortSignal unused (R1)   │
  │ sslmode in credential(R4)│         │ plaintext loopback (R5)   │
  └──────────────────────────┘         └───────────────────────────┘
```

Zoom in: each risk below names the evidence, the trigger that makes it bite, and
the move to fix it.

## The ranked findings

### R1 — No request timeout on the model call (highest consequence)

```
  trigger: Ollama hangs (model load, OOM, stuck generation)
  result:  agent.answer never resolves → Ink spinner spins forever

   await agent.answer(q)   ── no AbortSignal, no deadline
   └─ aptkit transport accepts `signal` … buffr passes none
```

**Evidence:** `src/session.ts:62` calls `agent.answer(question)` with no signal;
aptkit's `defaultHttpTransport` honors a `signal` if given but buffr supplies
nothing. **Why it's #1:** it's the only failure mode with *no exit* — every other
failure throws and ends the turn; this one hangs indefinitely. **Move:** thread
`AbortSignal.timeout(ms)` from `ask` into `agent.answer` (the slot already exists).
→ `07-timeouts-retries-pooling-and-backpressure.md`.

### R2 — No retry on transient failures

```
  trigger: Ollama 503 (swapping models) or a momentary connection refusal
  result:  immediate throw → "error: ollama HTTP 503" → user re-types
```

**Evidence:** the `res.ok` binary split in aptkit's transport throws on any
non-2xx; no retry wrapper anywhere in `session.ts` or the CLI. **Why it matters:** a
single jittered retry would silently recover the most common transient blip.
**Move:** wrap the model call in one retry with short backoff for 503 /
connection-refused. **Honest framing:** for a local model the blip window is small,
so this is a real-but-modest gap. → `07`.

### R3 — Connection pool runs on defaults

```
  trigger: DATABASE_URL points at an unreachable/slow host
  result:  pool.connect() waits on the OS TCP timeout (tens of seconds)
           — no fast failure at startup
```

**Evidence:** `src/db.ts:4` — `new pg.Pool({ connectionString })` with no options:
no `connectionTimeoutMillis`, default `max: 10`, no `idleTimeoutMillis`. **Why it's
mid-rank:** for one local user, `max: 10` and idle handling never bite; only the
*connect timeout* gap has teeth, and only against a bad/remote host. **Move:** set
`connectionTimeoutMillis` so a dead DB fails fast. → `07`, `03`.

### R4 — TLS policy is unenforceable from code

```
  trigger: a deployment sets sslmode=disable (or prefer) against a remote DB
  result:  password + pg-wire cross the network in cleartext, silently
```

**Evidence:** `src/db.ts:4` has zero TLS code; the whole policy is the `sslmode`
parameter inside `DATABASE_URL`, which buffr can't read or assert on. **Why it's
lower (today):** the DB is single-device — there's no network to sniff. It climbs
to near the top the instant the DB moves off-box. **Move:** for a remote DB, require
`sslmode=verify-full` and ideally assert it in `loadConfig`. **This is a shared
boundary with `study-security`** — that guide judges *whether* it's safe; this guide
names *where* the decision lives. → `04`.

### R5 — Plaintext HTTP to the model server

```
  trigger: Ollama moves off the loopback interface (off-box)
  result:  prompts + completions cross the network unencrypted
```

**Evidence:** `cfg.ollamaHost = "http://localhost:11434"` (`src/config.ts:14`) —
plain HTTP. **Why it's low (today):** it's loopback; nothing leaves the machine, so
there's nothing to intercept and no peer to authenticate. **Move:** only relevant
if the model server is remoted — then it needs HTTPS and the host becomes a real
trust boundary. → `04`, `05`.

### Lower-consequence / structurally absent

- **No request collapse / embed dedupe.** Two identical embeds both hit
  `/api/embed`. Wasteful, not harmful, at single-user scale. → `07`.
- **No backpressure beyond the UI busy-guard.** `if (busy) return`
  (`src/cli/chat.tsx:17`) serializes one user's turns; there's no queue bound for
  multi-caller load — which buffr never generates. → `07`.
- **No streaming.** A UX limitation (spinner until done), not a risk. → `06`.

## What is NOT a red flag (and why)

Naming the non-issues is as useful as naming the risks — it shows the absences are
deliberate, not overlooked:

```
  absent, and correctly so:

  CORS         no browser → CORS can't fire. Not a gap.
  cookies      stateless POSTs, no auth → nothing to carry. Not a gap.
  WebSocket/SSE no inbound server, no browser client → no home. Not a gap.
  inbound auth  buffr accepts no connections → no attack surface inbound.
  DNS failure   localhost = loopback, DB likely local → no DNS on the wire.
```

These are `not yet exercised` because the architecture has no place for them — not
because they were forgotten. The best-effort memory write
(`src/session.ts:65-69`) is the one place buffr makes a *correct* explicit
network-failure decision, and it's worth calling out as a positive.

## Primary diagram

```
  buffr networking risk ranking — recap

  R1  model-call timeout      HIGH   src/session.ts:62 (no AbortSignal)
  R2  transient retry         MED    aptkit res.ok throw, no retry
  R3  pool default knobs      MED    src/db.ts:4 (no connectionTimeoutMillis)
  R4  TLS unenforceable       LOW→HIGH if remote   src/db.ts:4 (sslmode in URL)
  R5  plaintext model HTTP    LOW→HIGH if remote   src/config.ts:14

  not flags (no home in this architecture):
    CORS · cookies · WebSocket · SSE · inbound auth · DNS failure
```

## Elaborate

The pattern across this audit: buffr's risks are *latent*, gated on a dependency
becoming slow/flaky (R1–R3) or a service moving off-box (R4–R5). That's the
healthy risk profile for a local-first CLI — the dangerous surface (inbound
servers, browser policy, remote-untrusted hosts) simply doesn't exist yet. The
single highest-leverage fix is R1's timeout: one `AbortSignal`, one bounded
failure, the slot already wired in aptkit. Everything else is either deferred
correctly (R2, R3) or a future-deployment concern (R4, R5).

## Interview defense

**Q: What's the biggest networking risk in this codebase?**

```
  R1: a hung model call has no timeout → spinner forever
  fix: AbortSignal.timeout threaded into agent.answer (slot exists)
```

Answer: "A model call with no timeout. `agent.answer` is awaited with no
`AbortSignal` (`src/session.ts:62`), so a wedged Ollama hangs the turn
indefinitely — the only failure mode with no exit. The fix is small: aptkit's
transport already accepts a `signal`, so thread an `AbortSignal.timeout` through.
Everything else either throws-and-ends or is a future-deployment concern."

**Q: Is the lack of CORS handling a problem?**

Answer: "No — it's not a gap, it's an absence with no home. CORS is browser policy;
buffr is a Node CLI with no browser, so it can't fire. Same for WebSocket, SSE, and
inbound auth — the architecture has no place for them. Calling those 'missing' would
be inventing a risk."

**Q: When does the TLS situation become urgent?**

Answer: "The moment the database moves off-box. Today it's `sslmode` in the
credential against a local DB, so there's nothing on the wire — `src/db.ts` has zero
TLS code by design. Remote it, and you need `sslmode=verify-full` plus ideally a
code-side assertion, because nothing currently stops `sslmode=disable`. That safety
judgment is the security guide's call; this audit just pins where the decision
lives."

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — R1/R2/R3 in depth
- `04-tls-and-trust-establishment.md` — R4/R5 in depth
- `00-overview.md` — the ranked findings and the full not-yet-exercised list
- `study-security` — whether each boundary is *safe* (the WHETHER to this guide's WHAT)
- `study-database-systems` — the storage engine behind the pg-wire socket

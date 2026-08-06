# 08 · Networking Red-Flags Audit

> Ranked protocol and network-failure risks, grounded in the repo — Project-specific
> · verdict-first: what would actually hurt, in order

## Zoom out, then zoom in

This is the file that ranks the wire-level risks by *consequence*, not by
template. The headline verdict is unchanged in kind but sharper in degree:
buffr's networking is small and mostly correct for what it is — a
single-device, single-user CLI with a bounded outbound fan-out for research —
and its risks are almost entirely *missing resilience*, not *broken
behavior*. What changed this pass: the fan-out to six real internet APIs
widened the blast radius of the #1 risk (no timeout, anywhere) without adding
any new mitigation for it, while also adding two genuinely good new patterns
(bounded pool teardown, fan-out failure tolerance) worth crediting, plus one
small, concrete, fixable gap (an unguarded JSON parse in one connector that a
sibling connector already learned to guard against).

```
  Zoom out — where the red flags live on the map

  ┌─ Process ────────────────────────────────────────────────────────┐
  │  session.ask() / researchCollect()  ── no timeout anywhere         │ ◄ R1, R2
  └───────┬──────────────────┬─────────────────────┬──────────────────┘
          │ pg-wire           │ HTTP (Ollama)        │ HTTPS × 6 (Collector.execute)
          ▼                   ▼                      ▼
  ┌─ Pool ────────────┐ ┌─ aptkit transport ──┐ ┌─ @buffr/connectors ─────────────┐
  │ default knobs (R3) │ │ AbortSignal unused   │ │ Promise.all: throws OK (R1a),   │
  │ sslmode (R4)        │ │  (R1)                 │ │  hangs NOT OK (R1b, worse now)  │
  │ bounded teardown ✓  │ │ plaintext loopback   │ │ Reddit's unguarded parse (R6)   │
  └──────────────────────┘ │  (R5, unchanged)     │ │ Trends's guard — a positive     │
                            └───────────────────────┘ └───────────────────────────────────┘
```

Zoom in: each risk below names the evidence, the trigger that makes it bite, and
the move to fix it.

## The ranked findings

### R1 — No request timeout, anywhere — and `Promise.all` only protects against half the failure modes (highest consequence)

```
  trigger: Ollama hangs, OR any one of six /research connectors hangs
  result:  R1a (Ollama): agent.answer never resolves → spinner forever
           R1b (connector): Promise.all in Collector.execute never resolves →
                             the ENTIRE /research or /investing turn hangs forever,
                             even though the other 5 connectors already succeeded
```

**Evidence:** `agent.answer(question)` is awaited with no `AbortSignal`
(`src/session.ts`); `Collector.execute` (`packages/capabilities/src/collector/index.ts:35-52`)
calls `source.connector.fetch(source.params)` with no `opts` — every one of
the six connectors accepts a `FetchOptions.signal`
(`packages/connectors/src/contracts.ts:15`) and none is ever given one. **Why
it's still #1, and worse than last pass:** it's still the only failure mode
with *no exit* — every other failure throws and ends the turn; this one hangs
indefinitely. What's new is the blast radius: `Collector.execute`'s
`Promise.all` + per-source `try/catch` *does* add real fault tolerance — a
connector that throws (a 429, a connection refusal, a malformed body crashing
`res.json()`) is caught and downgraded to a `failed[]` entry, and the batch
still completes. But `Promise.all` requires every promise to *settle*, and a
`fetch()` that simply never resolves (a stalled TCP handshake, a server that
accepts the connection and never responds) never settles — so one silently
wedged connector, among six, blocks the whole turn forever, silently
discarding the evidence the other five already collected. This is a subtler
and arguably more consequential version of the original single-connector gap:
before, a hang cost you one failed feature; now it can cost you a turn that
was otherwise 5/6 successful. **Move:** thread `AbortSignal.timeout(ms)` into
`agent.answer`; pass `{ signal: AbortSignal.timeout(ms) }` as `opts` in
`Collector.execute`'s `source.connector.fetch(source.params, opts)` call —
every connector already honors it, the call site just needs to supply it.
→ `07-timeouts-retries-pooling-and-backpressure.md`.

### R2 — No retry on transient failures (model or any connector)

```
  trigger: Ollama 503 (swapping models), Google 429 (quota), Brave/Tavily 5xx,
           Reddit rate-limiting
  result:  immediate throw → surfaces as a `failed[]` entry or a UI error
```

**Evidence:** no retry wrapper anywhere in `session.ts`, the CLI, or
`Collector.execute`. **Why it matters:** a single jittered retry would
silently recover the most common transient blip (Ollama swap, a momentary
connector 5xx). Web APIs add a failure mode a local model server doesn't have
— Google 429 (daily quota exhausted, observed during development) is not
transient; retrying would only burn more quota. The right move is to
distinguish: retry 503/connection-refused (transient), do NOT retry 429
(quota), and log the difference. **Move:** wrap the model call and
`Collector.execute`'s per-source fetch in one retry with short backoff for
5xx/connection-refused; pass 429 through as a non-retryable error. → `07`.

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

### R6 — Reddit's response parse is unguarded against the exact failure Google Trends already learned to guard against

```
  trigger: Reddit rate-limits or bot-checks the request, returns 200 + an HTML
           interstitial instead of the expected JSON listing
  result:  res.json() throws an uncaught SyntaxError-class error — not a clean
           "Reddit search HTTP 429" message, a raw parse crash
```

**Evidence:** `reddit-search.ts:58-60` checks `res.ok` but then calls
`await res.json()` with no guard on the body shape
(`packages/connectors/src/discovery/reddit-search.ts:60`). Compare
`search-trends.ts:73-76`, fixed this pass specifically for this failure class:
`if (typeof raw === 'string' && raw.trimStart().startsWith('<')) throw new
Error('Google Trends returned an HTML page — likely rate-limited or
blocked')`. Both connectors hit public, unauthenticated, rate-limited
JSON-ish endpoints prone to serving an HTML block page on a `200`. **Why it's
lowest of the numbered risks:** it hasn't been observed firing (filed honestly
as latent, not confirmed), and when it does fire it still throws — caught by
`Collector.execute`'s `try/catch`, same as any other connector failure, so it
degrades to "Reddit's evidence is missing" rather than crashing the whole
turn. What makes it worth naming on its own rather than folding into the
"lower-consequence" bucket below: it's a two-line copy-paste fix of a pattern
that already exists, sitting one file over, unapplied. **Move:** copy the same
`startsWith('<')` guard (or equivalently, a try/catch specifically around
`res.json()` with a clearer error message) into
`reddit-search.ts`. → `05-http-semantics-caching-and-cors.md`.

### Lower-consequence / structurally absent

- **No request collapse for concurrent duplicates.** The new 1h TTL
  `CachedConnector` (`packages/connectors/src/cached-connector.ts`) now catches
  *sequential* duplicate connector calls and identical repeat embeds within the
  window — a real improvement over last pass. Two truly simultaneous identical
  calls, issued before either resolves, still both fire. → `07`.
- **No backpressure beyond the UI busy-guard.** `if (busy) return`
  (`src/cli/chat.tsx`) serializes one user's turns; there's no queue bound for
  multi-caller load — which buffr never generates. → `07`.
- **No streaming.** A UX limitation (spinner until done), not a risk. The new
  live progress panel doesn't change this — it's in-process callbacks, not a
  network transport. → `06`.

## What is NOT a red flag (and why)

Naming the non-issues is as useful as naming the risks — it shows the absences are
deliberate, not overlooked. One entry changed this pass: DNS failure used to have
no home in this architecture; now it does, and it's deliberately *not* elevated to
a numbered risk.

```
  absent, and correctly so:

  CORS          no browser, on ANY of the 7 HTTP clients → CORS can't fire.
  cookies       stateless calls, no auth → nothing to carry.
  WebSocket/SSE no inbound server, no browser client → no home.
  inbound auth  buffr accepts no connections → no attack surface inbound.

  present now, but not elevated to a numbered risk:

  DNS failure   reddit.com / googleapis.com / etc. are real, stable, well-known
                hosts — a resolver failure against them is exactly as likely as
                against any well-run SaaS API, i.e. low. It's a genuine new
                failure mode (see 02), just not a HIGH one; a resolver failure
                surfaces the same way any other connector rejection does —
                caught by Collector.execute, downgraded to failed[].
```

These are `not yet exercised` (or, for DNS, exercised-but-low-risk) because the
architecture has no place for them, or the place it has isn't dangerous — not
because they were forgotten. Three things are worth calling out as **positives**
this pass, not absences: the best-effort memory write
(`src/session.ts`) is still the one place buffr makes a *correct* explicit
network-failure decision; the bounded pool teardown (`03`) is the first place
"shut down within N seconds" became an explicit contract; and the connector
fan-out's per-source `try/catch` (`07`) is real fault tolerance for the most
common connector failure shape, even though it doesn't cover hangs.

## Primary diagram

```
  buffr networking risk ranking — recap

  R1  timeout — model AND 6 connectors   HIGH   Collector.execute (Promise.all
                                                  tolerates throws, not hangs)
  R2  transient retry — model+connectors MED    every fetch: res.ok throw, no retry
  R3  pool default knobs                 MED    src/db.ts:4 (no connectionTimeoutMillis)
  R4  TLS unenforceable (pg-wire)        LOW→HIGH if remote   src/db.ts:4 (sslmode)
  R5  plaintext model HTTP               LOW→HIGH if remote   src/config.ts:14
  R6  Reddit unguarded JSON parse        LOW, latent   reddit-search.ts:60 vs
                                                         search-trends.ts:73-76 (fixed)

  positives this pass (not risks — worth crediting):
    bounded pool teardown (03) · connector fan-out failure tolerance (07)
    · Google Trends' HTML-body guard (05) · 1h TTL connector cache (07)

  not flags (no home, or a genuinely low-risk new surface):
    CORS · cookies · WebSocket · SSE · inbound auth
    DNS failure (real now, but against stable hosts — low, see 02)
```

## Elaborate

The pattern across this audit hasn't changed in kind: buffr's risks are still
*latent*, gated on a dependency becoming slow/flaky (R1–R3, R6) or a service
moving off-box (R4–R5). What changed is the surface area under R1 — it used to
be one dependency (Ollama) that could hang; it's now seven (Ollama plus six
concurrent connectors), and the fan-out's `Promise.all` makes the *thrown*
half of that surface safer while leaving the *hung* half exactly as exposed as
before, just with a bigger blast radius when it fires. That's the single most
important thing to understand about this pass's changes: adding fault
tolerance for one failure mode (rejection) without adding it for the sibling
failure mode (a hang) can make a system's risk profile look better in the
common case while making the tail case worse. The single highest-leverage fix
is still R1's timeout — now two call sites instead of one, both small, both
named. Everything else is either deferred correctly (R2, R3), a
future-deployment concern (R4, R5), or a small, concrete, already-solved-once
gap (R6).

## Interview defense

**Q: What's the biggest networking risk in this codebase?**

```
  R1: no timeout anywhere — Ollama OR any of 6 /research connectors
  Promise.all in Collector.execute survives a THROW, not a HANG
  fix: AbortSignal.timeout threaded into agent.answer AND Collector.execute
```

Answer: "No timeout, anywhere — and it's worse than it sounds because of how
the new connector fan-out works. `Collector.execute` runs six connectors
through `Promise.all`, each wrapped in `try/catch`, so a connector that
*throws* doesn't sink the batch — real fault tolerance. But `Promise.all`
waits for every promise to *settle*, and a connector whose `fetch()` just
hangs — no reject, no resolve — never settles. So a single wedged connector,
among six, blocks the entire `/research` or `/investing` turn forever, even
though the other five already succeeded and their evidence is sitting
unused in memory. Same root cause as the old single-connector Ollama gap,
now with six candidates instead of one and a worse outcome when it fires."

**Q: What's new and actually good this pass?**

Answer: "Three things. A bounded pool teardown — `pool.end()` now races a
1-second timeout so a wedged connection can't hang `/exit`. Fan-out failure
tolerance — one connector throwing doesn't sink a `/research` batch anymore.
And Google Trends' connector added a body-shape guard for an endpoint known to
return HTML instead of JSON under rate-limiting — the same failure class
Reddit's connector is still exposed to, unfixed (R6)."

**Q: Is the lack of CORS handling a problem?**

Answer: "No — it's not a gap, it's an absence with no home, on any of the
seven HTTP clients now, not just the original two. CORS is browser policy;
buffr is a Node CLI with no browser, so it can't fire. Same for WebSocket, SSE,
and inbound auth. Calling those 'missing' would be inventing a risk."

**Q: Does the new DNS/TLS surface from the connectors worry you?**

Answer: "Not as a red flag. Real DNS and real TLS to six internet hosts is
new, but it lands on the safe default in both cases — Node's `fetch` verifies
certificates by default, and nothing in the repo weakens that, and the hosts
are stable, well-known APIs, not attacker-controlled endpoints. It's a
genuinely new failure surface (see `02`), just not a high-consequence one. The
one place this line of thinking gets sharper is the RSS connector, where the
hostname is caller-supplied rather than hardcoded — that's a `study-security`
question, not a `study-networking` risk."

**Q: When does the TLS situation become urgent?**

Answer: "The moment the database moves off-box. Today it's `sslmode` in the
credential against a local DB, so there's nothing on the wire — `src/db.ts` has zero
TLS code by design. Remote it, and you need `sslmode=verify-full` plus ideally a
code-side assertion, because nothing currently stops `sslmode=disable`. That safety
judgment is the security guide's call; this audit just pins where the decision
lives."

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — R1/R2, the fan-out mechanism, and the cache in depth
- `04-tls-and-trust-establishment.md` — R4/R5, and the connectors' default-verified HTTPS
- `05-http-semantics-caching-and-cors.md` — R6, and the three-way body-parse comparison it's drawn from
- `02-dns-routing-and-addressing.md` — why DNS is a real (if low) surface now
- `00-overview.md` — the ranked findings and the full not-yet-exercised list
- `study-security` — whether each boundary is *safe* (the WHETHER to this guide's WHAT); the RSS connector's caller-supplied host
- `study-database-systems` — the storage engine behind the pg-wire socket

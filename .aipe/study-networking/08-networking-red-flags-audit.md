# Networking Red-Flags Audit

**Industry name(s):** network-failure risk audit / resilience review.
**Type:** Project-specific.

## Zoom out, then zoom in

This is the verdict file. It ranks every protocol- and network-failure
risk in `buffr-laptop` by consequence, names the evidence for each, and is
blunt about what's a real bug versus what's latent versus what's a
non-issue at this scale. The headline: **the risks are all "what happens
when a peer leaves the box," and today every peer is on the box** — so the
posture is defensible now and fragile the moment addressing goes remote.

```
  Zoom out — where each risk lives

  ┌─ UI (chat.tsx) ──────────────────────────────────────────┐
  │  R1 infinite hang (no timeout behind the spinner)         │ ← HIGH
  └─────────────────────────────┬─────────────────────────────┘
  ┌─ Orchestration (session/db) ▼────────────────────────────┐
  │  R2 no retries · R4 pool defaults (connectTimeout:0)      │ ← MED/LOW
  └─────────────────────────────┬─────────────────────────────┘
  ┌─ Transport / config ─────────▼───────────────────────────┐
  │  R3 sslmode imposes no TLS floor (→ study-security owns)  │ ← MED
  │  R5 connection-leak-by-missed-release (guarded today)     │ ← LOW
  └──────────────────────────────────────────────────────────┘
```

Zoom in. The concept is a **ranked risk audit**: not a flat list of
"things that could be better," but a consequence-ordered set of verdicts,
each with a file:line, a concrete failure scenario, and the move that fixes
it. Severity here means *blast radius × likelihood given the realistic
deployment* (a remote Supabase Postgres, per project context).

## Structure pass

**Layers.** The risks distribute across UI, orchestration, and transport —
but they share one root cause, which is the axis.

**Axis — "does the risk fire when a peer is local vs remote?"** This single
question sorts the whole audit:

```
  axis: "local peer vs remote peer — when does the risk fire?"

  ┌─ R1 infinite hang ─────────┐  local: rare   remote: ROUTINE  → HIGH
  ┌─ R2 no retries ────────────┐  local: rare   remote: common   → MED
  ┌─ R3 no TLS floor ──────────┐  local: moot   remote: REAL     → MED
  ┌─ R4 pool connectTimeout:0 ─┐  local: never  remote: possible → LOW
  ┌─ R5 missed release() ──────┐  guarded by finally everywhere  → LOW

  every risk's severity is a function of "has a peer left the box?"
```

**Seam.** The load-bearing seam for the entire audit is the addressing
boundary from file `02`: `localhost`/loopback vs a remote DNS host. On the
local side of that seam, R1–R4 are dormant. Cross it and they wake up
together. That's why the audit is really one finding wearing five hats.

## How it works

### Move 1 — the mental model

Think of these as a circuit breaker panel: most breakers are fine, one or
two are warm to the touch, and which ones trip depends entirely on the load
you put on the circuit. Here the "load" is *network distance*. At loopback
load, nothing trips. Push remote load through the same panel and the
timeout breaker goes first.

```
  The risk panel — severity is set by network distance

   local load (loopback):   [R1 ok][R2 ok][R3 n/a][R4 ok][R5 ok]
   remote load (Supabase):  [R1 ⚠⚠][R2 ⚠ ][R3 ⚠ ][R4 ⚠ ][R5 ok]
                                ▲
                    R1 trips first and hardest
```

### Move 2 — the ranked findings

Each finding: the verdict, the evidence, the concrete failure, the move.

**R1 — No request timeout: a slow peer hangs the turn forever. (HIGH)**

```
  R1 — the hang has no floor

  evidence:  session.ts:62  await agent.answer()   ← no AbortSignal
             pg-vector-store search/upsert         ← no statement timeout
             chat.tsx:48    <Spinner/> thinking…   ← spins with no deadline
  scenario:  remote Postgres stalls mid-query, OR Ollama wedges
             mid-generation → ask() never resolves → spinner spins ∞
             → only escape is kill -9 the process
  move:      AbortSignal.timeout(ms) on the Ollama path; a pg statement
             timeout on queries. Bound EVERY network await.
```

This is #1 because the failure mode is a *silent* infinite wait, not a
visible error — the worst kind of failure, the one with no signal. Walked
in full in file `07`. Local peers rarely hang, which is why it's survived;
a remote `DATABASE_URL` makes hangs routine.

**R2 — No retries: one transient blip fails the whole turn. (MEDIUM)**

```
  R2 — no recovery from transient failure

  evidence:  no retry wrapper anywhere; every call is a bare await
             chat.tsx:30  catch → render "error: <msg>"  ← whole recovery
  scenario:  remote pg drops a connection, or Ollama returns a transient
             503 → the turn fails → user must retype the question
  move:      bounded retry (2–3 attempts) on idempotent calls — the search
             query, the embed — WITH backoff+jitter (R-adjacent). Do NOT
             blind-retry the non-idempotent inserts without care.
```

Medium, not high: a failed turn is *visible* (the user sees the error and
retypes), so it degrades UX but doesn't hang or corrupt. File `07` covers
the mechanism.

**R3 — sslmode imposes no TLS floor: encryption is config-only. (MEDIUM —
owned by study-security)**

```
  R3 — the code can't force encryption

  evidence:  db.ts:5  new pg.Pool({ connectionString })  ← no ssl object
  scenario:  ship .env with sslmode=disable (or omit it) against a REMOTE
             Postgres → DB password + every query travel in plaintext over
             the public internet, sniffable / MITM-able
  move:      for remote DBs, require sslmode=verify-full in .env; consider
             a startup assertion that rejects a remote host without it.
  ownership: the VERDICT (is this safe?) belongs to study-security; this
             audit only flags that the network layer offers no floor.
```

Medium and explicitly cross-linked: file `04` walks the mechanism
(`require` encrypts but doesn't verify; only `verify-full` does), and
**`study-security`** owns whether the shipped posture is acceptable. Listed
here so the network audit is complete, not to duplicate that verdict.

**R4 — Pool defaults: `connectionTimeoutMillis: 0` waits forever for a
connection. (LOW today, latent)**

```
  R4 — untuned pool, one sharp default

  evidence:  db.ts:5  new pg.Pool({ connectionString })  ← no tuning
             defaults: max=10, idle=10s, connectionTimeout=0 (wait ∞)
  scenario:  all 10 conns busy/unreachable → pool.connect() blocks forever
             (a second face of R1, at the pool layer)
  why LOW:   single-user CLI, one turn at a time (busy flag, chat.tsx:13)
             → never approaches max=10. Latent until concurrency rises.
  move:      set connectionTimeoutMillis (e.g. 5s) so connect() fails fast
             instead of hanging; revisit max if usage ever fans out.
```

Low because the `busy` flag caps concurrency at one (file `07`), so pool
exhaustion can't happen at current scale. It's here as a latent gap, not a
live bug.

**R5 — Connection leak if a `release()` is ever missed. (LOW — currently
guarded)**

```
  R5 — leak risk, currently defended

  evidence:  pg-vector-store upsert() · migrate.ts runMigration()
             both: client = pool.connect() ... finally { client.release() }
  scenario:  a future manual-lease path that forgets the finally → that
             conn never returns → repeat → pool exhausts → deadlock,
             silently, no error
  why LOW:   every existing manual lease HAS the finally+release. The risk
             is regression, not a present defect.
  move:      keep the connect/try/finally/release discipline; prefer
             pool.query() (auto-return) wherever a single statement suffices.
```

Low and almost a non-finding — it's here to name the discipline that keeps
it low (file `03`), so a future contributor doesn't break it.

**Non-issues — explicitly cleared.** So the audit is honest in both
directions:

```
  cleared — not risks in this shape

  · CORS / inbound auth / DDoS  → no inbound server (file 01). N/A.
  · WebSocket/SSE reconnect storms → no realtime transport (file 06). N/A.
  · UDP packet loss / reordering → no UDP (file 03). N/A.
  · DNS poisoning → default is loopback/hosts file (file 02). Minimal
    surface until a remote host is configured.
  · Backpressure overflow → single-user, busy-flag serialized (file 07).
```

### Move 3 — the principle

**A risk audit ranks by consequence-given-deployment, and names what's
cleared as carefully as what's flagged.** The strongest signal here isn't
the list of absences — it's recognizing they share one trigger (a peer
leaving the box) and that R1 (the silent infinite hang) is the one that
bites first and hardest. An audit that flagged all five as equal "missing
resilience" would teach less than this one, which says: fix the timeout
first, the rest follow, and half the textbook risks don't apply to this
shape at all.

## Primary diagram

The complete ranked audit in one frame.

```
  Networking red-flags — ranked by consequence

  HIGH   R1  no request timeout → silent infinite hang
             session.ts:62 · pg-vector-store · chat.tsx:48
             fix: AbortSignal.timeout + pg statement timeout

  MED    R2  no retries → one blip fails the turn (visible)
             bare awaits · chat.tsx:30 catch
             fix: bounded retry + backoff on idempotent calls
  MED    R3  no TLS floor → plaintext if .env says so  [study-security]
             db.ts:5 (no ssl object) · file 04
             fix: require verify-full for remote; startup assert

  LOW    R4  pool connectionTimeout:0 → connect() hangs (latent)
             db.ts:5 · guarded by busy-flag concurrency=1
  LOW    R5  missed release() → pool leak (currently guarded)
             upsert/migrate finally{release()} · keep the discipline

  CLEARED  CORS · WS/SSE · UDP · DNS-poisoning · backpressure
           (structurally N/A in this shape)

  common root: every flagged risk fires harder once a peer goes REMOTE
```

## Elaborate

The reason to rank rather than list: it tells the next engineer where to
spend the first hour. Here that's unambiguous — add a per-call timeout (R1)
and you remove the only *silent* failure mode in the system; everything
else either fails loudly (R2) or is dormant at this scale (R4, R5) or is a
security verdict to hand off (R3). The audit also doubles as a deployment
checklist: every flagged risk has the same trigger condition — "is the peer
remote?" — so "we're moving Postgres to Supabase" is precisely the moment to
work this list top to bottom. That coupling between the addressing decision
(file `02`) and the resilience gaps (file `07`) is the single most useful
thing to carry out of this whole guide.

## Interview defense

**Q: "What's the most serious networking risk in this codebase?"**

> The silent infinite hang. Every network call is a bare `await` with no
> timeout or `AbortSignal` — `session.ts:62` for Ollama, the pg queries for
> Postgres — and the Ink spinner has no deadline behind it. If a peer
> stalls mid-request, the turn never completes and the only escape is
> killing the process. It's the worst kind of failure because it's silent —
> no error, just a spinner forever. First fix: bound every network await
> with a timeout.

```
  R1 (HIGH): bare await → HANG → spinner ∞ → kill -9
  fix first; it's the only SILENT failure mode in the system
```

Anchor: *"`session.ts:62` is a naked await — no timeout, so a hung peer =
infinite spinner."*

**Q: "Which of these risks don't actually matter yet, and why?"**

> R4 (pool `connectionTimeout:0`) and R5 (release leak) are dormant at
> single-user scale — the `busy` flag caps concurrency at one turn, so the
> pool never approaches its max. And a whole class is structurally N/A:
> CORS, WS/SSE, UDP — buffr has no inbound server, no realtime transport,
> no UDP. The honest audit clears those, not just flags absences. The real
> trigger for the live risks is a peer going remote.

Anchor: *"`busy` flag (chat.tsx:13) caps concurrency at 1 → pool risks
latent; no inbound server → CORS/WS cleared."*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the mechanisms
  behind R1, R2, R4.
- `04-tls-and-trust-establishment.md` — the mechanism behind R3.
- `03-tcp-udp-connections-and-sockets.md` — the pool discipline behind R5.
- `02-dns-routing-and-addressing.md` — the local/remote seam that sets
  every severity.
- `study-security` — owns the R3 verdict and the broader trust-boundary
  review.

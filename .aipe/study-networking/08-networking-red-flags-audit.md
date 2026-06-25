# Networking Red-Flags Audit — ranked by consequence

**Protocol & network-failure risk ranking** · Project-specific

## Zoom out, then zoom in

This is the verdict file. Every other file taught a mechanism; this one ranks
what's actually risky on buffr's two wires, worst-first, with the evidence for
each call. The honest headline: **buffr's network risks are almost all
absences, and most of them are correctly absent for a single-user CLI.** The few
that aren't are concentrated in one place — the unguarded, untimed calls.

```
  Zoom out — where the risks live

  ┌─ Provider layer ────────────────────────────────────────────────┐
  │   Postgres :5432 (remote)        Ollama :11434 (loopback)       │
  └──────┬──────────────────────────────────┬──────────────────────┘
  ┌─ Risk surface ──────────────────────────────────────────────────┐
  │   ● hangs (no timeout)   ● TLS-by-string   ○ no retry (ok-ish)   │ ★ THIS FILE ★
  │   ● pool no connTimeout  ○ /exit-cleanup   ○ streaming absent(ok)│
  └──────┬──────────────────────────────────┬──────────────────────┘
  ┌─ Service layer ─────────────────────────────────────────────────┐
  │   src/db.ts · src/config.ts · src/cli/*                          │
  └──────────────────────────────────────────────────────────────────┘

  ● = real risk to fix/watch     ○ = acceptable given the CLI context
```

Zoom in: a red-flags audit answers "*if this breaks in production, what breaks
first and how bad is it?*" — ranked, not listed. The ranking is the value: a
flat list of twelve concerns teaches less than three real ones in order.

## Structure pass

**Layers.** Risks sort into three severities. Trace *consequence* — what does the
user actually experience — across them.

**Axis — "what does the user experience when this fails?"**

```
  One question across the risk tiers

  "what does the user experience?"

  ┌─ TIER 1: hangs ─────────────────────┐  → CLI freezes indefinitely,
  │  no timeout / no connTimeout         │     no feedback (worst UX)
  └──────────────────────────────────────┘
      ┌─ TIER 2: silent insecurity ─────┐  → works fine, but creds may cross
      │  TLS decided by string           │     the internet in cleartext
      └──────────────────────────────────┘
          ┌─ TIER 3: acceptable gaps ───┐  → no retry / no streaming; rerun or
          │  context makes them fine     │     wait covers it for a human
          └──────────────────────────────┘

  consequence drops sharply across tiers — that ordering IS the audit
```

**Seam.** The seam that separates Tier 1 from the rest is the missing
`AbortSignal`. Close that one seam and the worst tier (indefinite hangs)
collapses. Everything else is either operator config (TLS) or context-acceptable.

## How it works

### Move 1 — the mental model

Ranking risk is two multiplications you already do in code review: *likelihood ×
blast radius*, then *blast radius × how-hard-to-fix*. A rare, contained,
one-line fix ranks low; a likely, user-facing, structural gap ranks high.

```
  The ranking kernel

  risk score ≈ likelihood × user-impact

  high likelihood + freezes the CLI  ──► TIER 1 (fix first)
  low likelihood  + silent cleartext ──► TIER 2 (config discipline)
  any likelihood  + human covers it  ──► TIER 3 (acceptable)
```

### Move 2 — the ranked findings

**TIER 1 — indefinite hangs (fix first).**

*No call-site timeout.* `await agent.answer()` and every DB query run with no
`AbortSignal`. A hung Ollama (loading a 9B model) or a stalled connection freezes
the CLI for minutes with no feedback — and because `chat` is a long-lived session,
the hang freezes the *whole session*: `session.ask()` never resolves, so Ink never
restores the input and you can't even type `/exit`. **Likelihood: moderate**
(model load, flaky network). **Impact: high** (frozen session, no signal). **Fix:
one `AbortSignal.timeout(ms)` threaded through** — the seam already exists.
Evidence: `src/session.ts:62`. → `07`.

*Pool has no `connectionTimeoutMillis`.* A dead Supabase host makes the first
query hang on the OS connect timeout instead of failing fast. **Likelihood: low**
(stable managed host). **Impact: high** (hang). **Fix: set
`connectionTimeoutMillis` on the Pool.** Evidence: `src/db.ts:5`. → `03`, `07`.

```
  Tier 1 — the hang path

  ┌─ buffr ─┐ await (no signal) ┌─ slow/dead endpoint ─┐
  │ frozen  │ ─────────────────►│ never responds       │
  └─────────┘                   └──────────────────────┘
       └─ only the OS timeout (minutes) ever frees it
```

**TIER 2 — TLS decided by string, not code.** buffr sets no `ssl` option on the
Pool; encryption depends on `sslmode` inside `DATABASE_URL`, which the
`.env.example` doesn't pin. A deploy with `sslmode=disable` to a remote host
sends the password and every row in cleartext, and **no code catches it**.
**Likelihood: low** (Supabase defaults to TLS). **Impact: high if it happens**
(credential exposure). **Fix: pin `sslmode=verify-full` in the connection string
and document it; or set `ssl` explicitly on the Pool.** Evidence: `src/db.ts:5`,
`.env.example`. This one is also a `study-security` finding. → `04`.

```
  Tier 2 — the silent-cleartext path

  DATABASE_URL (no sslmode) ──► pg.Pool (no ssl:) ──► plaintext to remote
       │                                                     │
       └── nothing in buffr asserts encryption ──────────────┘
```

**TIER 3 — acceptable given the CLI context (watch, don't fix yet).**

*No network retry.* Transient failures throw and exit; re-running is the retry.
Fine for a human; the first thing to add if buffr goes unattended. → `07`.

*A thrown turn no longer leaks the pool — but the pool is now genuinely
long-lived.* Under the old one-shot `ask`, an `agent.answer()` throw unwound past
`pool.end()` and the OS reclaimed the socket on exit. Under `chat` that's flipped:
the throw is *caught* by the Ink handler (`src/cli/chat.tsx:30-34`) and rendered
as an `error:` line, so the session — and its warm pool — survive the bad turn.
That's better for resilience, but it means the pool genuinely lives for the whole
session, so the "OS reclaims on exit" safety net no longer applies *during* a run.
Pool cleanup now hinges on the user actually typing `/exit` to reach
`session.close()` (`src/session.ts:73`); a hard kill (Ctrl-C, crash) skips it and
leans on the OS. **Acceptable for a supervised CLI; revisit if unattended.**
Evidence: `src/cli/chat.tsx:18-21,30-34`, `src/session.ts:72-74`.

*No streaming.* Request/response only; a UX choice, not a risk. → `06`.

*No backpressure.* Sequential loops, nothing to overflow. Correct by structure.
→ `07`.

*Ollama plaintext HTTP.* Loopback — correct, not a risk. → `04`.

```
  Tier 3 — why these are fine

  no retry ........ human re-asks on the next turn
  thrown turn ..... caught by Ink, rendered as error; session survives
  no streaming .... one final answer, no UX need
  no backpressure . sequential for-loop is the flow control
  ollama plaintext  loopback ⇒ no path attacker
```

### Move 3 — the principle

A good audit ranks by consequence and is honest about what *isn't* a problem.
The skill people miss is the second half — listing every theoretical gap as
equally urgent signals you can't tell a freeze from a non-issue. buffr's real
network risk is one tier deep: untimed calls that can hang. Close that, pin TLS,
and the rest is correctly-sized for what the system is today: a single-user,
human-supervised, local-first CLI.

## Primary diagram

The full ranked audit, one frame.

```
  buffr networking red-flags — ranked

  TIER 1 (fix first) ─────────────────────────────────────────────
   ● no call-site timeout        src/session.ts:62      → AbortSignal
   ● pool no connectionTimeout   src/db.ts:5            → set it
  TIER 2 (config discipline) ─────────────────────────────────────
   ● TLS via string, not code    src/db.ts:5 + .env       → pin sslmode
                                                            (study-security)
  TIER 3 (acceptable today) ──────────────────────────────────────
   ○ no network retry            → re-ask next turn; add if unattended
   ○ pool cleanup needs /exit    src/cli/chat.tsx:18-21  → ok (supervised)
   ○ no streaming                → UX choice, not a risk
   ○ no backpressure             → structurally unnecessary
   ○ ollama plaintext            → correct (loopback)

  the whole Tier 1 collapses behind ONE seam: the AbortSignal buffr never makes
```

## Implementation in codebase

**Use cases.** This file is read when deciding what to harden before buffr runs
anywhere a human isn't watching it.

**Code side by side.** The two Tier-1 lines and the Tier-2 line, together:

```
  the three highest-ranked findings, in code

  src/db.ts:5
    new pg.Pool({ connectionString: databaseUrl })
        │   └─ Tier 2: no ssl: option → TLS is whatever the string says
        └───── Tier 1: no connectionTimeoutMillis → dead host hangs

  src/session.ts:62
    const answer = await agent.answer(question);
        └─ Tier 1: no AbortSignal → hung Ollama freezes the whole session

  one controller + one pool option + one pinned sslmode = all three closed
```

## Elaborate

Risk audits are most useful when they separate *severity* from *urgency*: a
high-severity, low-likelihood item (cleartext creds) can rank below a
moderate-severity, high-likelihood one (hangs) depending on context. buffr's
context — local, single-user, supervised — is what demotes most items to Tier 3.
The moment that context changes (server deployment, unattended cron), re-run
this audit: items move *up* tiers as the human backstop disappears. The audit is
a function of deployment, not just code — the same insight that drives `07`.

## Interview defense

**Q: What's the single most important network fix in this repo?**

```
  await agent.answer()  ──+── AbortSignal.timeout(ms) ──► hangs become errors
  pg.Pool               ──┘   + connectionTimeoutMillis
```

Answer: "Timeouts. No call has an `AbortSignal`, so a hung Ollama or dead DB host
freezes the CLI for minutes. One `AbortSignal.timeout()` threaded through the
calls and a `connectionTimeoutMillis` on the pool turns indefinite hangs into
fast, catchable errors — and since `chat` is long-lived, a hang today freezes the
whole session, not one command, which makes the fix more urgent. The whole worst
tier collapses behind that one seam." Anchor: `src/session.ts:62`, `src/db.ts:5`.

**Q: What network risks did you decide NOT to fix, and why?**

Answer: "Retries, streaming, backpressure, and pool-cleanup-needs-`/exit`.
They're all demoted by context — a human runs the CLI and watches it. Re-asking
on the next turn is the retry; a thrown turn is caught by Ink and the session
survives; there's no queue to apply backpressure to. The one that shifted is pool
cleanup: `chat`'s pool is genuinely long-lived, so it relies on `/exit` reaching
`session.close()` rather than process-exit. I'd revisit every one of them the day
buffr runs unattended." Anchor: `src/cli/index-cmd.ts:22-26`, `src/cli/chat.tsx:18-21`,
`src/session.ts:72-74`.

## Validate

1. **Reconstruct:** the three tiers and the one finding in each that defines it.
2. **Explain:** why does TLS rank Tier 2 (high severity) below hangs (Tier 1)?
   (likelihood — Supabase defaults to TLS; hangs are more probable.)
3. **Apply:** buffr becomes a cron job. Which Tier-3 items move up? (retry and
   pool-cleanup both rise — the human who re-asks and types `/exit` is gone.)
4. **Defend:** justify the single highest-priority fix. (`AbortSignal` timeout —
   collapses the entire hang tier, and a hang now freezes a whole session;
   `src/session.ts:62`.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — the pool config behind two findings.
- `04-tls-and-trust-establishment.md` — the Tier-2 TLS-by-string detail.
- `07-timeouts-retries-pooling-and-backpressure.md` — the mechanisms these
  findings are absences of.
- `study-security` — owns the credential-exposure half of the TLS finding.
- `study-system-design` — where re-running this audit on a new deployment lands.

Updated: 2026-06-24 — Repointed all Tier-1 timeout findings off the deleted `ask-cmd.ts` onto `src/session.ts:62`, and sharpened the consequence: a hang now freezes the whole long-lived `chat` session (input never returns), making the AbortSignal fix more urgent. Reworked the old "uncaught throw unwinds past pool.end()" Tier-3 finding: under `chat` a thrown turn is *caught* by Ink (`src/cli/chat.tsx:30-34`) and the session survives, but the pool is now genuinely long-lived so cleanup hinges on the user typing `/exit` → `session.close()` (`src/session.ts:73`) rather than process-exit.

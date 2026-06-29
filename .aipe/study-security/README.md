# Study — Security (buffr-laptop)

> The trust axis as a discipline: what can each side see, reach, or
> tamper with? This guide audits buffr-laptop's real files against the
> only question that matters — *what can an attacker reach, and what
> happens when they do?*

## The through-line

Every finding here ties to one trace: follow untrusted input across
every boundary and ask, at each one, whether the boundary *enforces* a
trust decision or *leaks* one.

```
  trace the trust axis across buffr's boundaries

  where does untrusted input enter?   → your question (you=user) +
                                         retrieved docs & recalled memory
  who is allowed past this boundary?  → no auth yet; single-device
  what's hidden, what's exposed?      → .env gitignored; DATABASE_URL =
                                         full-priv string in-process
  what do dependencies let in?        → lockfile present; no CVE CI gate
  what can the agent reach?           → ONE read-only tool, bounded loop
```

The verdict: **for the laptop phase the posture is honest and mostly
correct.** SQL is parameterized at every sink, the agent runs
least-privilege with hard budgets, secrets never left the machine. The
real exposures are *deferred controls*, not bugs — shape-only tenant
isolation and a client-held full-privilege credential — each acceptable
because there's one user (you), each with a named trigger that turns
the work on.

## The map

```
  ┌─ TRUSTED: laptop ──────────────────────────────────────────┐
  │  Ink TUI → session → agent (1 read-only tool, maxTurns 6,   │
  │                              maxToolCalls 4)                │
  └──────────────────┬─────────────────────────────────────────┘
                     │ DATABASE_URL (full-privilege)  ▲ TLS
  ┌─ Postgres (reindb / agents) ───────────────────────────────┐
  │  parameterized SQL only · app_id everywhere, NO RLS ◄ gap   │
  └──────────────────┬─────────────────────────────────────────┘
                     │ retrieved chunks + recalled memory  ▲ HTTP
  ┌─ Ollama (gemma2:9b, nomic-embed) ──────────────────────────┐
  │  tool results re-enter prompt ── injection surface (low)    │
  └────────────────────────────────────────────────────────────┘
```

## Reading order

Start with the audit for the full sweep, then the pattern files for the
controls that are actually doing work.

1. **`audit.md`** — Pass 1. The 8-lens audit, every lens walked with
   `file:line` grounding, the red-flags checklist as the capstone.
   Read this first; it cross-links to the pattern files below.

Then the Pass 2 discovered-pattern files — the security-shaped
mechanisms this repo actually exercises, named after the control, not
the lens:

2. **`01-parameterized-sql-boundary.md`** — why every DB write/read is
   injection-resistant, and the one place that *looks* like
   string-building but is a bound parameter.
3. **`02-shape-only-tenant-isolation.md`** — `app_id` on every table
   with no RLS and no token binding: a control *pre-shaped* for the
   phone/edge phase. What flips when it turns on (almost nothing).
4. **`03-indirect-prompt-injection-surface.md`** — indexed docs *and
   now recalled conversation memory* re-enter the prompt as tool
   results. Why the blast radius is low (it's capped by file 04).
5. **`04-least-privilege-tool-scope.md`** — the strongest control in
   the repo: one read-only tool, default-deny allowlist, bounded loop.
   The reason a hijacked agent's worst case is a wrong answer.

## Not yet exercised (honest)

These lenses don't apply yet. Each is correct-by-phase, not an
oversight — named here so the gap is visible and the target is
buildable:

- **Authentication & authorization** — no auth layer, no sessions, no
  per-resource checks. One principal (you). Target: token-derived
  `app_id` + RLS at the phone/edge phase (see file 02).
- **Row-level security** — `app_id` is shape-only. Target: Postgres
  RLS policy keyed on a session-set tenant (file 02).
- **Rate limiting** — no request throttle. N/A with a single local
  user and a bounded agent loop.
- **Secret rotation** — `.env` is static. Target: scoped, short-lived
  credentials once the credential leaves the laptop (audit lens 4).
- **Dependency-audit / CI** — lockfile present, but no `npm audit` /
  Dependabot / CI gate. Target: one-line `npm audit` CI job (audit
  lens 6).

## Cross-links

- **`../study-data-modeling/`** — the *shape* of `app_id`, `chunks`,
  `documents`, `messages`. This guide asks who may read/write them; that
  one asks how they're structured.
- **`../study-system-design/`** — the local-first architecture, the
  retrieval + memory pipeline, the agent loop these controls sit on.
- **`../study-database-systems/`** — how Postgres parses-then-binds (the
  mechanism under file 01) and how RLS would enforce file 02.
- **agent-architecture** (not yet generated) — the future home for the
  `runAgentLoop` control-flow deep walk that files 03/04 reference for
  the *security* read only.

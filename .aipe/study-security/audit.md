# Security audit — buffr-laptop

> Pass 1 of the two-pass audit. Eight lenses, walked against the real
> repo with `file:line` grounding. Where a finding is load-bearing
> enough to deserve a deep walk, it cross-links to a Pass 2 pattern
> file. Where the repo doesn't exercise a lens yet, it says so plainly
> and names the buildable target — no invented vulnerabilities, no
> softened real ones.

The verdict up front: **for the single-device laptop phase this repo's
trust posture is honest and mostly correct.** Every SQL sink is
parameterized, the agent runs on a one-tool least-privilege allowlist
with hard turn/tool budgets, and secrets stay in a gitignored `.env`
that was never committed. The real exposure is not a bug — it's a
*deferred control*: tenant isolation is shape-only (an `app_id` column
with no RLS and no token binding), and `DATABASE_URL` is a
full-privilege connection string held by the client process. Both are
acceptable while the only client is your laptop. Both become the first
thing you fix the day a phone or edge function holds that string.

The single worst exposure ranked across the whole audit:
**`DATABASE_URL` is a full-privilege Postgres credential held in the
application process** (`src/db.ts:4`, `src/config.ts:11`). On the
laptop it's you trusting your own machine. The moment that process
moves off the laptop, that one string is the whole castle.

---

## the trust map — read this first

Before the lenses, the one diagram the whole audit hangs on: where
untrusted input enters, and what each boundary does (or doesn't)
enforce.

```
  Trust-boundary map — buffr-laptop (laptop phase)

  ┌─ TRUSTED: your laptop ──────────────────────────────────────────┐
  │                                                                  │
  │  ┌─ UI (Ink TUI) ───────────┐                                    │
  │  │ src/cli/chat.tsx         │  you type a question               │
  │  │  onSubmit(value)         │                                    │
  │  └───────────┬──────────────┘                                    │
  │              │ in-process call (no network, no auth hop)         │
  │  ┌─ Session ─▼──────────────┐                                    │
  │  │ src/session.ts ask()     │  builds agent once, holds 1 convo  │
  │  └───────────┬──────────────┘                                    │
  │              │                                                   │
  │  ┌─ Agent loop (aptkit) ────▼─────────────────────────────────┐ │
  │  │ RagQueryAgent.answer()  policy: 1 tool, maxTurns 6,        │ │
  │  │   allowlist = [search_knowledge_base]   maxToolCalls 4     │ │
  │  └───────────┬───────────────────────────────────────────────┘ │
  │              │ DATABASE_URL (full-privilege string)              │
  └──────────────┼───────────────────────────────────────────────────┘
                 │  ▲ network boundary — TLS to Postgres
  ┌─ SEMI-TRUSTED: Supabase Postgres (reindb / agents) ────────────┐
  │  parameterized SQL only ($1..$8, $1::vector)                   │
  │  app_id column on every table  ── NO RLS, NOT token-derived ◄──┼─ the gap
  │  documents · chunks(+memory) · conversations · messages       │
  └────────────────────────────────────────────────────────────────┘
                 │  ▲ HTTP (localhost) — Ollama
  ┌─ LOCAL PROVIDER: Ollama (gemma2:9b, nomic-embed) ──────────────┐
  │  model output + retrieved chunks re-enter the prompt as        │
  │  tool results  ── indirect prompt-injection surface ───────────┤
  └────────────────────────────────────────────────────────────────┘
```

Two untrusted inputs cross into trusted code: (1) your typed question
(but you are the attacker model here — single-user), and (2) **content
that comes back from the database as tool results** — indexed
documents *and now recalled conversation memory* — which re-enter the
model's context. That second one is the only adversarial-content path
that matters at this phase, and its blast radius is small by design.

---

## 1. trust-boundaries-and-attack-surface

The attack surface is deliberately tiny because the whole app runs in
one process on one machine. There is **no HTTP server, no request
body, no query param, no header, no uploaded file** — the entry point
is `onSubmit` in the Ink TUI (`src/cli/chat.tsx:15`), a local keyboard
event. Nothing listens on a port.

Three boundaries are real and worth naming:

- **TUI → session**, in-process (`src/cli/chat.tsx:28` →
  `src/session.ts:60`). No serialization, no auth hop. The "request"
  is a function call. Trust assumption: the person at the keyboard is
  authorized. True on a laptop, false the moment this is exposed.
- **Process → Postgres**, over the network (`src/db.ts:4`). Carries
  the full-privilege `DATABASE_URL`. → see `01-parameterized-sql-boundary.md`
  for what crosses this and how it's defended.
- **Process → Ollama**, localhost HTTP (`src/session.ts:40,46`). The
  return path is where adversarial content can ride in — model output
  and retrieved chunks. → see `03-indirect-prompt-injection-surface.md`.

The red flag this lens hunts for — *input trusted because it came from
"our own frontend"* — is present but defanged: the TUI is the only
frontend and it's local. The honest statement: this isn't "we
validated the input," it's "there's only one user and it's you." That
distinction is the whole laptop-phase security story.

## 2. authentication-and-authorization

**Not yet exercised.** There is no authentication layer and no
authorization layer. There are no sessions, no tokens, no login, no
per-resource checks. `agents.conversations.user_id` and
`agents.profiles.user_id` columns exist (`sql/001_agents_schema.sql:35,55`)
but are never written — they're schema shape waiting for an identity
that doesn't exist yet.

This is correct for single-device. There is exactly one principal (you)
and nothing to authorize against. Naming it as a gap would be
dishonest about the phase: you don't authenticate a process talking to
its own laptop.

The buildable target, stated so it's concrete: when buffr grows a
second client (the phone/edge phase), `app_id` stops being a constant
`'laptop'` (`src/config.ts:11`) and must become **token-derived** —
extracted from a verified session, not read from an env default — and
the database must enforce it with RLS, not trust the app to pass the
right value. That's the jump from "shape-only isolation" to "enforced
isolation." → see `02-shape-only-tenant-isolation.md` for why the
shape is already in place and what flips when the control turns on.

## 3. input-validation-and-injection

This is where the repo is genuinely strong, and it's worth being
precise about why.

**SQL injection: resistant everywhere.** Every query that touches
user- or model-derived data uses parameterized placeholders — the
value never becomes part of the SQL string. Verified at every sink:

- `src/pg-vector-store.ts:47` — chunk upsert, `$1..$8`, embedding as
  `$6::vector`.
- `src/pg-vector-store.ts:70` — vector search, `$1::vector`, `app_id`
  `$2`, `k` `$3`. Even the kNN order-by binds the vector as a parameter.
- `src/runtime.ts:11` — documents upsert, `$1..$4`.
- `src/profile.ts:5` — profile read, `app_id` `$1`.
- `src/supabase-trace-sink.ts:27` — message insert, `$1..$8`.
- `src/supabase-trace-sink.ts:5` — conversation insert, `$1,$2`.

The one place a vector becomes text — `toVectorLiteral`
(`src/pg-vector-store.ts:15`) builds `[0.1,0.2,...]` — is **not** a SQL
hole: the string is passed as a bound parameter (`$1::vector`,
`src/pg-vector-store.ts:55,70`), not concatenated into the query. The
numbers come from the embedder, not free text, and pg casts the bound
literal. → `01-parameterized-sql-boundary.md` walks the one trap
(building a `vector` literal) that *looks* like string-building but
isn't.

The session and memory paths add **no new SQL** — memory writes go
through `PgVectorStore.upsert` (`src/session.ts:53` →
`@aptkit/memory` → the parameterized upsert), so they inherit the same
defense. No string-built query exists in this repo.

**Migration runner: trusted-by-design.** `runMigration`
(`src/migrate.ts:12`) executes a whole SQL file as one statement. That
*is* arbitrary SQL execution — but the input is a file you wrote and
ship in the repo (`sql/001_agents_schema.sql`), not user input. The
trust assumption (the migration file is author-controlled) holds; this
is not an injection sink.

**Prompt injection: present, bounded.** See lens 7.

**Command / path / SSRF / XSS:** N/A. No shell exec, no
user-controlled filesystem path in the chat path (the `index` CLI
reads paths from `argv`, `src/cli/index-cmd.ts:14` — operator input,
not remote), no browser DOM, no user-controlled outbound URLs.

## 4. secrets-and-configuration

Clean for the phase. The findings, ranked:

- **`.env` is the single secret store and it's gitignored.**
  `.gitignore:2` lists `.env` and `.env.local`. `.env.example` ships
  empty placeholders (`DATABASE_URL=`) with the warning "never commit
  real creds." A history scan found no `.env` ever committed and no
  `postgres://` / password literal in any tracked `src/` or `sql/`
  file. Secrets are loaded at runtime via `dotenv`
  (`src/session.ts:35`, `src/migrate.ts:24`, `src/cli/index-cmd.ts:10`).
- **No secret reaches a client bundle.** There is no client bundle —
  the Ink TUI runs in the same Node process that holds the env. There
  is no browser, no `NEXT_PUBLIC_`-style leak vector.
- **No secret in logs.** Errors surface as
  `error: ${(err as Error).message}` in the TUI
  (`src/cli/chat.tsx:31`) — a message string, never the connection
  config. The trace sink persists model/tool events
  (`src/supabase-trace-sink.ts`), never the `DATABASE_URL`.

The one structural risk to flag — and it's a *posture* risk, not a
leak: **`DATABASE_URL` is a full-privilege connection string held in
the application process** (`src/db.ts:4`, `src/config.ts:11`). The
laptop process can do anything to `reindb` because the credential
grants everything. Acceptable now (the client is your own machine; the
blast radius is your own data). The control to add at the phone/edge
phase: the client should hold a *scoped, short-lived* credential (a
Supabase anon/role key behind RLS, or a token-minted connection), not
the owner string. Naming this now is the point — the schema already
carries `app_id` so the isolation the scoped credential would enforce
is pre-shaped. → `02-shape-only-tenant-isolation.md`.

## 5. data-exposure-and-privacy

Low surface, one thing to watch.

- **No over-fetching to a caller.** Queries select only what's used:
  `search` returns id/content/score/meta (`src/pg-vector-store.ts:71`),
  `loadProfile` selects `content` only (`src/profile.ts:5`). There's no
  API returning rows to an untrusted client — the only consumer is the
  in-process agent.
- **Error messages are not verbose.** The TUI shows `err.message`
  (`src/cli/chat.tsx:31`), not a stack trace or DB internals. Pool
  errors that would carry the connection string are not surfaced to a
  rendered string.
- **The privacy detail worth naming: full-signal trajectory capture.**
  `SupabaseTraceSink` (`src/supabase-trace-sink.ts`) persists *every*
  `CapabilityEvent` — step content, tool-call args, tool results,
  token usage — into `agents.messages`. Your questions, the retrieved
  passages, and recalled memory all land in the database in cleartext.
  On a single-user laptop writing to your own `reindb` that's a feature
  (replayable trajectory). It becomes a data-exposure concern the
  moment that DB is multi-tenant without RLS: the `messages` and
  `chunks` (memory) rows of one `app_id` are protected only by the app
  remembering to filter on `app_id` — see the next lens-7 and
  `02-shape-only-tenant-isolation.md`. The control that closes it is
  the same one (RLS), so it's not a second fix.

## 6. dependencies-and-supply-chain

- **Lockfile present.** `package-lock.json` exists (35 KB, tracked).
  Installs are reproducible; no "no lockfile" red flag.
- **Tight, current dependency set.** `package.json` pins one app
  toolkit (`@rlynjb/aptkit-core ^0.4.1`) plus `pg`, `dotenv`, `ink`,
  `react`. No sprawling transitive web framework. aptkit-core
  `bundledDependencies` the `@aptkit/*` workspace packages, so the
  agent loop, tools, memory, and providers come from one vetted bundle
  you author — not anonymous npm packages.
- **Update / audit posture: not yet exercised.** There is no `npm
  audit` step, no Dependabot/Renovate config, no CI running a
  dependency check. No evidence of a postinstall-script risk in the
  direct deps, but nothing *verifies* that on every install. The
  buildable target: add `npm audit --omit=dev` (or `audit-ci`) to a CI
  job so a known-CVE in `pg` or a transitive dep fails the build. One
  line of CI; not present today.

## 7. llm-and-agent-security

This is the lens that matters most for an AI repo, and buffr gets the
two big decisions right.

- **Least-privilege tool scope — the strongest control in the repo.**
  The agent is granted exactly one tool. `ragQueryToolPolicy` declares
  `allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME]`
  (`@aptkit/agent-rag-query`), `filterToolsForPolicy` builds an
  allowlist `Set` and filters the catalog down to it
  (`@aptkit/tools` `tool-policy.js`), and buffr only ever registers
  that one tool (`src/session.ts:43-44`). The tool is **read-only** —
  a knowledge-base search, no write/exec/network-egress capability.
  Even if the model is fully hijacked, the worst it can do is *search*.
  → `04-least-privilege-tool-scope.md` for the full walk.
- **Bounded turns — the budget the loop can't exceed.** `runAgentLoop`
  runs `for (let turn = 0; turn < maxTurns; turn++)` and forces a final
  answer when `toolCalls.length >= maxToolCalls`
  (`@aptkit/runtime` `run-agent-loop.js:25,27`). RagQueryAgent passes
  `maxTurns: 6, maxToolCalls: 4`. There is no unbounded
  reason-act loop; a hijack can't spin forever or fan out tool calls.
- **Indirect prompt injection — present, low blast radius.** Indexed
  documents come back as tool results (`src/pg-vector-store.ts:80`),
  and *now so does recalled conversation memory* — memory rows live in
  the same `chunks` table tagged `meta.kind='memory'` and resurface
  through the **same** `search_knowledge_base` tool (`src/session.ts:52-53`,
  `@aptkit/memory`). So a poisoned passage — or a poisoned earlier
  turn that got remembered — re-enters the model's context as
  retrieved content. The trust assumption "retrieved text is data, not
  instructions" is *not* enforced by a gate; it's held by the two
  controls above. Why that's acceptable: the agent is allowlisted to
  one read-only tool with a 4-call budget, so the model can be *talked
  into* a bad answer but cannot be talked into *an action* — there's no
  write tool, no exec, no exfil channel to redirect. The blast radius
  is a wrong answer, not a breach. → `03-indirect-prompt-injection-surface.md`.
- **Output handling.** Model output flows to the TUI as display text
  (`src/cli/chat.tsx:29`). It does **not** flow into any SQL, shell, or
  fs sink — the only thing built from data near the model is the vector
  literal, and that's from the embedder, bound as a parameter. No
  "model emits SQL → we run it" path exists. Correct.

The honest gap at this lens: there's **no content-level injection
defense** (no delimiting of retrieved text, no instruction-stripping,
no separate "data" channel). It's not needed yet *because* the tool
scope makes injection low-value. It becomes worth adding the day the
agent gets a second, non-read-only tool. That's the same trigger as
the auth/RLS work — the controls turn on together.

## 8. security-red-flags-audit

The capstone checklist, fired against this repo.

```
  flag                                 status   where / why
  ───────────────────────────────────  ───────  ─────────────────────────
  string-built SQL with user input     DOESN'T  all sinks parameterized
                                                 ($1..$8, $1::vector)
  secret in source / bundle / logs     DOESN'T  .env gitignored, never
                                                 committed; no client bundle
  no lockfile                          DOESN'T  package-lock.json tracked
  endpoint checks authn not authz      N/A      no endpoints, no auth yet
  verbose error leaks internals        DOESN'T  TUI shows err.message only
  agent tool set exceeds task          DOESN'T  1 read-only tool, allowlist
                                                 enforced (lens 7)
  unbounded agent loop                 DOESN'T  maxTurns 6 / maxToolCalls 4
  model output into a sink (SQL/exec)  DOESN'T  output → display only
  ───────────────────────────────────  ───────  ─────────────────────────
  tenant isolation enforced (RLS)      FIRES    app_id shape-only, no RLS,
                                       (defer)   not token-derived
                                                 → acceptable: single user
  client holds full-priv credential    FIRES    DATABASE_URL = owner string
                                       (defer)   in process (src/db.ts:4)
                                                 → acceptable: own laptop
  indirect prompt injection gated      FIRES    no content gate on retrieved
                                       (low)     docs + recalled memory
                                                 → low blast radius (lens 7)
  dependency CVE check in CI           FIRES    no npm audit / CI gate
                                       (defer)   → add one-line audit job
```

Three flags fire as *deferred* and one as *low-severity-by-design*.
None is a bug; each is a control whose absence is justified by the
single-device phase, with a named trigger (a second client, a second
tool) that turns the work on. The two-pass split below makes the
deliberate controls — the ones that *are* doing work today — into
their own files.

# Security Audit — buffr-laptop (Pass 1)

The 8-lens walk. Every lens gets a verdict: what the code actually does,
with `file:line` grounding, or `not yet exercised` when the single-device
shape hasn't built the boundary yet.

**The one thing to take away first:** this is a single-operator,
single-device tool with no network listener. That collapses most of the
classic attack surface — there is no authenticated request to forge, no
session to hijack, no CORS to misconfigure. The trust model is "if you can
run `npm run chat`, you already own the laptop." So the audit is honest
about what's deferred and spends its weight on the three boundaries that
*do* carry a trust decision: the SQL sink, the `app_id` tenant shape, and
the LLM context.

---

## 1. trust-boundaries-and-attack-surface

The whole attack surface in one frame — where untrusted input crosses into
trusted code.

```
  Inputs crossing into trusted code

  source                         enters at                  trust today
  ─────────────────────────────  ─────────────────────────  ───────────
  prompt "your question"         chat.tsx:55 → session.ts:60 operator = trusted
  *.md file contents             index-cmd.ts:23 (readFile) operator-chosen
  indexed chunk text → LLM       run-agent-loop.js:104      ★ semi-trusted ★
  recalled memory text → LLM     session.ts:53,66 → search  ★ semi-trusted ★
  Ollama HTTP responses          session.ts:40,46           local, trusted
  DATABASE_URL                   config.ts:11               operator secret
```

The real boundary is rows three and four. Everything the operator types or
chooses to index is trusted by definition — it's their laptop. But once a
document is indexed, its **text re-enters the model's context as a tool
result** (`run-agent-loop.js:104`, where `toolResults` are pushed as a
`user` message). That is the place where content the operator may not
have *written* (a downloaded README, a scraped page) gets to influence the
model. The chat session now adds a second retrievable source: after each
turn, the question+answer exchange is embedded into the **same** vector
store as `kind=memory` chunks (`session.ts:53,66`), so past conversation
turns also become retrievable context on later turns. That widens *what
can be surfaced* — but it's the same surface and the same one read-only
tool, so the blast radius is unchanged. → `03-indirect-prompt-injection-surface.md`.

The classic red flag — "trusted because it comes from our own frontend" —
doesn't fire here because there *is* no frontend and no second origin. The
inverse risk applies instead: the design assumes the operator is the only
actor, so the day a network listener is added (the phone/edge phase the
plan names in `agent-layer-plan.md`), every one of these rows needs
re-checking.

---

## 2. authentication-and-authorization

**`not yet exercised`** — and deliberately so.

There is no authentication layer: no login, no token, no session. The CLI
trusts `process.argv` and `process.env` directly (`session.ts:35-37`,
`config.ts:9-16`). Authorization is shape-only: every table carries
`app_id` (`sql/001_agents_schema.sql:6,19,34,54`) and every query filters
on it (`pg-vector-store.ts:74`, `profile.ts:6`, `supabase-trace-sink.ts:6`),
but `app_id` is a **constant from the environment** (`config.ts:12`,
default `'laptop'`), not derived from any authenticated identity. There is
no per-resource authz check because there is no caller identity to check
against.

This is correct for the laptop phase — there is one operator and one
device. The gap becomes real the moment a second tenant shares the database.
→ `02-shape-only-tenant-isolation.md` walks why the shape is there now and
what flips it on.

The classic authz gap (authn present, authz assumed) can't fire yet because
neither exists. The buildable target: when the HTTP phase lands, derive
`app_id` from a verified token claim, never from a request field or env
default.

---

## 3. input-validation-and-injection

This is where the repo earns its strongest mark. **Every SQL sink is
parameterized.** Walked one by one:

- **Vector upsert** — `pg-vector-store.ts:47-56`. Values bound as
  `$1..$8`, the embedding cast `$6::vector`. The vector itself is built by
  `toVectorLiteral` (`:15-17`) as a string, but it's still passed as a
  *bound parameter*, not concatenated into the SQL text. **Memory writes
  reuse this exact sink:** `createConversationMemory({ embedder, store })`
  (`session.ts:53`) and `memory.remember(...)` (`session.ts:66`) embed the
  exchange and call the same `PgVectorStore.upsert` — no new SQL path, same
  parameterization.
- **Vector search** — `pg-vector-store.ts:70-78`. The query vector
  (`$1::vector`), `app_id` (`$2`), and `k` (`$3`) are all bound. `<=>` is
  the pgvector distance operator, not interpolated user data.
- **Document insert** — `runtime.ts:11-16`. `id`, `app_id`, `source_path`,
  `content` all bound `$1..$4`.
- **Profile read** — `profile.ts:5-6`. `app_id` bound `$1`.
- **Conversation / message inserts** — `supabase-trace-sink.ts:5-7,27-36`.
  All bound; the `created_at` value is bound and coalesced
  (`coalesce($8::timestamptz, now())`).

There is no string-built query anywhere in `src/`. **`session.ts`** — the
new long-lived chat session — contains *no SQL of its own*: every database
touch goes through `startConversation` / `persistMessage` (the
trace-sink helpers) or through `PgVectorStore` (search + memory upsert),
all parameterized. The migration runner
(`migrate.ts:13`) executes a whole SQL *file* as one statement, but that
file is repo-controlled (`sql/001_agents_schema.sql`), not user input — not
an injection sink. → `01-parameterized-sql-boundary.md` for the deep walk.

**Other injection classes:**
- *Command injection* — `not exercised`. No `exec`/`spawn` anywhere.
- *Path traversal* — the only `fs` reads are operator-supplied argv paths
  (`index-cmd.ts:23`, `eval-cmd.ts:20`). On a single-device tool the
  operator already has the filesystem; no privilege boundary is crossed.
- *SSRF* — `ollamaHost` comes from env (`config.ts:14`), used by the
  embedder and model provider in `session.ts:40,46`, not from request
  data, so the model HTTP target isn't attacker-controllable today.
- *Prompt injection* — fires. → lens 7.

---

## 4. secrets-and-configuration

One secret: `DATABASE_URL`. Hygiene is correct, with one forward-looking
flag.

- **Where it lives** — `.env`, read via `dotenv` (`session.ts:35`,
  `migrate.ts:24`, `index-cmd.ts:10`, etc.) into `loadConfig`
  (`config.ts:11`). Never hard-coded.
- **What's in the repo** — `.env` is gitignored (`.gitignore:2`), and
  `.env.example` (`:6`) ships an empty `DATABASE_URL=` with a "never commit
  real creds" comment. The example file is the right pattern. (A real `.env`
  exists on disk locally but is gitignored — confirm it was never committed
  with `git log --all --full-history -- .env`.)
- **No client bundle** — there's no browser build, so no secret can leak
  into shipped JS. The `dist/` output is server-side Node only.
- **Logs** — the secret is never written to stdout. Error messages on a
  missing URL say `'DATABASE_URL is not set (see .env)'` (`session.ts:37`),
  not the value.

**The forward flag — full-privilege credential, client-held.** The
connection string is a *full-privilege* Postgres credential: whoever holds
it can read and write every row in `agents.*`, across every `app_id`, with
no RLS to stop them. On the laptop that's fine — the operator owns the DB.
But the plan (`agent-layer-plan.md`) names a centralized Supabase and a
future phone/edge phase. The moment this credential lives on a device you
don't physically control, "full-privilege connection string in a client"
becomes the finding. The fix for that phase: a scoped role + RLS, or a
server tier that holds the credential and the client holds a short-lived
token. Named now so it's not a surprise later. → `02-` covers the RLS half.

Secret rotation: `not yet exercised` — there's no rotation mechanism, which
is fine for one local credential and a gap for a shared one.

---

## 5. data-exposure-and-privacy

Single operator, single device — there's no "caller entitled to less than
they get," because the caller is entitled to everything. So most of this
lens is structurally N/A. Two real notes:

- **Trajectory capture stores everything — and now stores *more*.**
  `agents.conversations` and `agents.messages` persist every turn. The
  trace sink now captures **all six** `CapabilityEvent` variants, not just
  assistant steps and tool results: `step`, `tool_call_start` (with the
  tool *args* — the cause), `tool_call_end` (result + `durationMs` + error),
  `model_usage` (provider/model + token counts), `warning`, and `error`
  (`supabase-trace-sink.ts:56-84`). That's *intended* — a complete,
  replayable trajectory for future fine-tuning (`agent-layer-plan.md`),
  and it fills the previously-orphaned `tokens_used` column. But it's a
  minor data-at-rest consideration: tool-call arguments and model usage now
  live in Postgres indefinitely alongside the question text, with no
  redaction and no TTL. Memory chunks (`session.ts:66`) add a second copy of
  the exchange in `agents.chunks`. On a shared DB that's a privacy surface;
  on the laptop it's your own data.
- **Error verbosity.** Errors throw raw (`pg-vector-store.ts:60-64`
  re-throws after rollback; CLI errors throw strings). There's no error
  handler that leaks a stack to a *remote* caller because there's no remote
  caller. When the HTTP phase lands, raw error propagation becomes a
  data-exposure finding — Postgres errors can echo SQL and column names.

No PII in logs beyond what the operator types. No over-fetching across a
trust boundary, because there's only one tenant reaching its own rows.

---

## 6. dependencies-and-supply-chain

Small, lockfiled, low surface.

- **Lockfile present** — `package-lock.json` exists at the root.
  Reproducible installs.
- **Runtime deps** — `@rlynjb/aptkit-core@^0.4.1` (the agent/RAG toolkit,
  first-party), `dotenv`, `pg`, plus the chat TUI stack: `ink`,
  `ink-spinner`, `ink-text-input`, `react` (`package.json:13-20`). `pg` is
  battle-tested node-postgres; `dotenv` is tiny. The `ink`/`react` deps are
  the new surface — they render the terminal UI (`cli/chat.tsx`) and never
  touch the network or the database, so they don't sit on a trust boundary.
  The largest trust surface is still `aptkit-core` itself — it's your own
  published package, so the supply-chain risk is really "do you trust your
  own build pipeline," a different question from a random transitive dep.
- **No postinstall scripts** in the direct deps' manifest surface worth
  flagging here; the install footprint is small.
- **Update posture** — `not yet exercised`. No `npm audit` in CI (there's
  no CI config in the repo), no Dependabot. For a three-dep local tool the
  exposure is low, but running `npm audit` before the HTTP phase is the
  cheap move.

No known-CVE red flag fires on this dependency set as shaped.

---

## 7. llm-and-agent-security

This is the lens that matters most for an AI repo, and buffr does two
things right and carries one inherent surface.

**The surface — indirect prompt injection.** The agent's only tool is
`search_knowledge_base` (`session.ts:43`). When the model calls it, the
retrieved chunk text is JSON-stringified and pushed back into the
conversation as a `user` message (`run-agent-loop.js:79,97-104`). That text
came from whatever was indexed (`index-cmd.ts:23-24` → `runtime.ts:17`) —
*and now also from recalled conversation memory*. After each turn the chat
session embeds the question+answer into the **same** vector store tagged
`kind=memory` (`createConversationMemory`, `session.ts:53`; `memory.remember`,
`session.ts:66`), so past turns surface through the very same search tool on
later turns. So a document — or an earlier exchange that captured hostile
text — containing "ignore your instructions and..." is now sitting in the
model's context as data the model reads. This is the classic RAG injection
surface and it's *inherent* to retrieval; memory slightly **widens** what can
be surfaced (past turns are now retrievable) without changing the blast
radius — it's still the one read-only tool. → `03-indirect-prompt-injection-surface.md`.

**Control 1 — least-privilege tool scope.** The blast radius of that
injection is small because the agent can only *search*. The policy
`ragQueryToolPolicy` allows exactly one tool
(`rag-query-agent.js:7-11`), and `filterToolsForPolicy`
(`tool-policy.js:2-10`) strips the model's tool menu down to that allowlist
before every run (`rag-query-agent.js:36-37`). There is no write tool, no
shell tool, no fetch tool. An injected instruction can at worst make the
model run another search — it can't exfiltrate, can't delete rows, can't
call out to the network. → `04-least-privilege-tool-scope.md`.

**Control 2 — bounded loop.** Hard caps stop a runaway or a
prompt-injection-induced loop: `maxTurns: 6`, `maxToolCalls: 4`
(`rag-query-agent.js:48-49`), enforced in `run-agent-loop.js:25-28` with a
forced synthesis turn when the budget is spent (`:30-32`,
`buildSynthesisInstruction` at `:17-19`). Tool output is also truncated at
16K chars (`run-agent-loop.js:2-7`) — a blast-radius limiter, not a
sanitizer.

**Output handling.** Model output is *not* treated as code or SQL. The
`agent.answer()` return is a plain string rendered to the terminal as a
React text node (`session.ts:63` → `cli/chat.tsx:29,46`). No `eval`, no
model-emitted SQL reaching a query sink. The one place model output
influences a query is the tool's `filter`
arg, and the tool deliberately treats a hallucinated filter key as a no-op
rather than letting it wipe results (`search-knowledge-base-tool.js:48-53`).

**The honest gap:** there's no input/output content gate on the retrieved
text — nothing scans an indexed chunk for injection markers before it
reaches the model. That's acceptable now (low blast radius, single
operator, you chose what to index), and it becomes worth building when the
corpus includes content from sources you don't control.

---

## 8. security-red-flags-audit

The consolidated checklist, marked against this repo.

```
  red flag                                fires?  where / why
  ──────────────────────────────────────  ──────  ───────────────────────────
  String-built SQL with user input        NO      all sinks parameterized
                                                   (pg-vector-store.ts:47,70;
                                                   memory reuses same upsert)
  Input trusted "from our own frontend"   N/A     no frontend exists
  Endpoint checks authn not authz         N/A     no auth layer yet (lens 2)
  Secret in source / client bundle        NO      .env gitignored (.gitignore:2)
  Secret in logs                          NO      only "not set" messages
  Full-privilege cred on a client         DEFERRED .env DATABASE_URL — fine on
                                                   laptop, flag for edge phase
  No tenant isolation (RLS)               DEFERRED app_id is shape-only, no RLS
                                                   (sql/001 — no policies). → 02
  No lockfile                             NO      package-lock.json present
  Known-CVE dep unpatched                 NO      3 small deps, none flagged
  Command injection sink                  NO      no exec/spawn
  Path traversal across priv boundary     NO      operator-supplied paths only
  SSRF (request-controlled URL)           NO      ollamaHost from env, not input
  Agent tool set exceeds task             NO      one read-only tool, allowlisted
                                                   (rag-query-agent.js:7-11) → 04
  Model output into a sink ungated        NO      output is a printed string
  Prompt injection via indexed content    FIRES   inherent RAG surface, now
    AND recalled conversation memory               also recalled memory
                                                   (session.ts:53,66); low
                                                   blast radius → 03
  Unbounded agent loop                    NO      maxTurns/maxToolCalls capped
  Raw error to remote caller              N/A     no remote caller yet (lens 5)
  Secret rotation mechanism               DEFERRED none — fine for one local cred
```

**Verdict.** Two findings *fire or defer* with weight: tenant isolation is
shape-only (DEFERRED, the most important one) and indexed content is an
indirect-prompt-injection surface (FIRES, but low blast radius behind a
one-tool allowlist). Everything else is either clean or honestly `not yet
exercised` because the single-device shape hasn't built the boundary it
would guard. The repo's security posture is *appropriate to its phase* —
the parameterized-SQL discipline and the least-privilege tool scope are
real, deliberate controls, not accidents.

Updated: 2026-06-24 — purged `ask`/`ask-cmd.ts` refs → `chat` (`session.ts` + `cli/chat.tsx`); re-verified all SQL sinks incl. `session.ts` (no new SQL, memory upsert reuses parameterized `PgVectorStore`); noted recalled conversation memory widens the injection surface (lens 1, 7, 8); trace sink now persists all 6 events incl. tool args + model usage (lens 5); aptkit-core 0.4.1 + ink/react TUI deps (lens 6); re-grounded file:line.

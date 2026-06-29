# Security audit — buffr-laptop

Pass 1. Eight lenses, walked against the real codebase. Each names what the code
actually does with `file:line` grounding, or says `not yet exercised` and gives
the buildable target. The capstone (lens 8) consolidates the checklist.

The verdict up front: **this is a single-operator laptop brain, and its threat
model reflects that.** The one network-reachable adversary path that matters today
is content the operator feeds in — indexed docs and recalled memory re-entering
the prompt. The SQL boundary is genuinely injection-resistant, and the agent's
tool scope is genuinely minimal. Everything that looks alarming in a multi-tenant
SaaS checklist (no auth, no RLS) is correctly absent because there's no second
tenant and no remote caller yet.

---

## 1. Trust boundaries and attack surface

Map every place untrusted input crosses into trusted code.

```
  Where input enters buffr-laptop

  ┌─ operator keystrokes ─┐   the chat question (src/cli/chat.tsx:15)
  │  TTY, in-process      │   → session.ask() → agent loop
  └───────────────────────┘   trust: operator = owner. Not remote.

  ┌─ indexed markdown ────┐   files passed to `npm run index`
  │  src/cli/index-cmd.ts │   → embedded → re-enters prompt as tool output
  └───────────────────────┘   trust: AUTHORED by operator, but echoed to LLM

  ┌─ recalled memory ─────┐   past exchanges, re-embedded (session.ts:64)
  │  @aptkit/memory       │   → re-enters prompt via the SAME search tool
  └───────────────────────┘   trust: model-generated text, recycled as input

  ┌─ DATABASE_URL ────────┐   full-privilege Postgres creds, .env (gitignored)
  │  loaded via dotenv     │   → every pool query runs with these rights
  └───────────────────────┘

  ┌─ Ollama HTTP ─────────┐   localhost:11434, no auth on the loopback
  │  gemma2 + nomic-embed │   → generation + embeddings
  └───────────────────────┘
```

The real boundaries:

- **The TTY → agent boundary.** The chat question enters at `src/cli/chat.tsx:15`
  (`onSubmit`), goes to `session.ask()` (`src/session.ts:60`). There is no remote
  caller — the operator typing at the terminal *is* the owner. No "trusted because
  it came from our frontend" assumption to abuse, because there's no frontend over
  a network.
- **The content → prompt boundary.** This is the one that matters. Indexed docs
  (`src/cli/index-cmd.ts`) and recalled memory (`src/session.ts:64`) both flow
  back into the model's context as tool results. That's indirect prompt injection
  (the prompt-injection surface) — walked in lens 3 and `03-indirect-prompt-injection-surface.md`.
- **The app → Postgres boundary.** Every query crosses through node-postgres
  parameterized statements (`$1::vector` etc.). That's the SQL boundary — lens 3
  and `01-parameterized-sql-boundary.md`.
- **The app → Ollama boundary.** Plain HTTP to `localhost:11434`
  (`providers/gemma/src/gemma-provider.ts:204`, `retrieval/src/ollama-embedding-provider.ts:63`
  in aptkit). Loopback only, no key. Not network-exposed in this phase.

The zoom-out: one operator, one device. The attack surface is the content the
operator chooses to index plus the local database file. No request bodies, no
query params, no headers, no uploads from a stranger.

---

## 2. Authentication and authorization

**`not yet exercised` — and correctly so.** There is no authentication layer:
no sessions, no tokens, no login. `agents.conversations` and `agents.profiles`
carry a nullable `user_id` column (`sql/001_agents_schema.sql:35,55`) that is
**never written** — `startConversation` inserts only `app_id` and `agent_name`
(`src/supabase-trace-sink.ts:5-7`). There is no per-resource authz check anywhere,
because there is no "other user" to deny.

This is the right call for single-device: the OS user account *is* the auth
boundary. Whoever can open the terminal owns the data.

**The buildable target (phone/edge phase):** when a second device or a remote
caller appears, `user_id` becomes the identity, a token (JWT or Supabase auth)
populates it, and the `app_id`/`user_id` pair becomes the authz key enforced by
RLS (lens 4). The column is already there waiting — the shape anticipates the
control without yet enforcing it.

---

## 3. Input validation and injection

Two sinks, two verdicts.

**SQL — injection-resistant. The control holds.** Every query that touches user
or model text uses parameterized statements (the placeholders `$1`, `$2`, …),
never string concatenation:

- `PgVectorStore.upsert` — `src/pg-vector-store.ts:47-56`, all 8 columns bound as
  `$1`–`$8`, the embedding as `$6::vector`.
- `PgVectorStore.search` — `src/pg-vector-store.ts:70-78`, query vector `$1::vector`,
  `app_id` `$2`, `k` `$3`.
- `indexDocumentRow` — `src/runtime.ts:11-16`, `$1`–`$4`.
- `persistMessage` / `startConversation` — `src/supabase-trace-sink.ts:6,27-36`.
- `loadProfile` — `src/profile.ts:5-6`, `app_id` `$1`.

The one place a value is *serialized into text* is the vector literal
(`toVectorLiteral`, `src/pg-vector-store.ts:15-17`) — but it joins a
`number[]` the embedder produced, and `assertDim` (`src/pg-vector-store.ts:32-36`)
throws on the wrong length. No string path carries attacker-controlled text into a
query. Deep walk: `01-parameterized-sql-boundary.md`.

One nuance worth naming: `migrate.ts` runs a whole SQL file as one statement
(`src/migrate.ts:13`, `client.query(sql)`). That's a developer-authored migration
script, not user input — acceptable. It would be a flag only if the SQL filename
or contents came from outside; they don't.

**Prompt — injection surface, real but low-blast-radius.** Indexed docs and
recalled memory re-enter the model context as tool results
(`run-agent-loop.ts:189` in aptkit). That's indirect prompt injection. There's no
sanitization gate on retrieved content — but the blast radius is bounded by lens 7
(one read-only tool, bounded turns). Deep walk:
`03-indirect-prompt-injection-surface.md`.

No command execution, no filesystem path built from user input, no SSRF (the only
outbound HTTP targets are hardcoded `localhost` Ollama endpoints), no XSS (the UI
is an Ink TTY, not a DOM).

---

## 4. Secrets and configuration

One secret, handled correctly. The connection string (`DATABASE_URL`) is the only
credential in the system — Ollama on loopback needs no key.

- It lives in `.env`, which is gitignored (`.gitignore:2`). `.env.example` ships
  empty (`DATABASE_URL=` with no value) so nothing real is committed.
- It's loaded via `dotenv` at every entrypoint (`src/migrate.ts:24`,
  `src/session.ts:35`, `src/cli/index-cmd.ts:10`, `src/cli/eval-cmd.ts:9`) and
  passed to `createPool` (`src/db.ts:4`). `loadConfig` reads it purely from `env`
  (`src/config.ts:11`) — no hardcoded fallback string.
- It is **never logged**. The trace sink persists model/tool events
  (`src/supabase-trace-sink.ts`) but never the connection string; error paths
  surface `(err as Error).message` (`src/cli/chat.tsx:31`), not config.

The honest gap: `DATABASE_URL` is a **full-privilege connection string held by the
client** (the client-held-credential risk). On the laptop that's fine — the client
*is* the trusted owner. The moment this moves to a phone or edge function, that
same string becomes a credential sitting on a device you don't fully control,
granting full read/write to `reindb`. The fix for that phase is a scoped role
(read-only or RLS-bound) and short-lived credentials, not a static superuser DSN.
This is the through-line to `02-least-privilege-tool-scope.md`: least privilege
already governs the *agent's tools*; it doesn't yet govern the *database role*.

**Secret rotation:** `not yet exercised`. No rotation mechanism, no vault. One
static string in a file. Acceptable single-device; a rotation story is phone-phase
work.

---

## 5. Data exposure and privacy

The data here is personal-knowledge content and a `me.md`-style profile — PII by
nature, but it's the operator's own data on the operator's own machine.

- **No over-fetch to a remote caller**, because there's no remote caller. The
  search tool returns ranked chunks with 160-char snippet citations
  (`retrieval/src/search-knowledge-base-tool.ts:108-117`) — to the local model, in
  the local process.
- **Error messages.** `src/cli/chat.tsx:31` surfaces `(err as Error).message` to
  the operator's own terminal. On a shared service that could leak internals; on a
  single-operator TTY the operator is entitled to see it. Acceptable.
- **The trace sink** persists full trajectory including tool args and results
  (`src/supabase-trace-sink.ts:62-71`) into `agents.messages`. That's deliberate
  observability (replayable trajectory), and it lands in the same single-tenant DB
  the operator already owns. No new exposure.
- **Field-level access control:** `not yet exercised` — there's no caller to
  withhold fields from.

The one forward-looking note: because memory and documents share one store
(`src/session.ts:53`, `04-shape-only-tenant-isolation.md`), a future second tenant
without RLS could `search` across the boundary. Today there's no second tenant, so
nothing leaks. Named in lens 4 (the patterns file) and the red-flags table.

---

## 6. Dependencies and supply chain

Posture is reasonable for the phase.

- **Lockfile present** — `package-lock.json` (35 KB, committed). Installs are
  reproducible.
- **Surface is small** — runtime deps are `@rlynjb/aptkit-core`, `dotenv`, `ink`
  (+ two ink addons), `pg`, `react` (`package.json`). aptkit is first-party
  (the operator's own toolkit), consumed and never edited here per the project's
  must-not-change constraint.
- **No postinstall scripts** in this package's `package.json` — nothing runs on
  install from buffr's own manifest.
- **`not yet exercised`:** no `npm audit` in CI, no automated dependency updates,
  no CI at all (`.github/workflows` absent). The buildable target: an `npm audit`
  step plus Dependabot/Renovate once there's a CI pipeline. At single-device scale
  with a small first-party-heavy tree, the risk of an unpatched transitive CVE is
  low but unmeasured — measuring it is the next move.

---

## 7. LLM and agent security

This is an AI repo, so this lens carries weight. Three sub-questions:

**Tool/permission scope — minimal, by design.** The agent is granted exactly one
tool. `ragQueryToolPolicy` allowlists `search_knowledge_base` and nothing else
(`agents/rag-query/src/rag-query-agent.ts:15-18` in aptkit), and
`filterToolsForPolicy` (`tools/src/tool-policy.ts:11-23`) intersects the registry
against that allowlist before any schema reaches the model. The tool is read-only
— it runs `pipeline.query`, a `SELECT` (`src/pg-vector-store.ts:67`). No write
tool, no shell, no fetch is reachable by the model. That's least privilege made
concrete. Deep walk: `02-least-privilege-tool-scope.md`.

**Bounded turns.** The loop caps at `maxTurns: 6` and `maxToolCalls: 4`
(`agents/rag-query/src/rag-query-agent.ts:75-76`). On the final turn `forceFinal`
strips the tool schemas entirely (`run-agent-loop.ts:106`), so the model is forced
to answer from what it has — it can't loop forever or fan out unbounded queries.

**Output handling — model output is never a sink.** The agent's `finalText` is
returned as a string to the TTY (`src/session.ts:62` → `chat.tsx:29`). It is never
`eval`'d, never run as SQL, never written back as a tool argument that hits a
privileged sink. Tool *results* re-enter the prompt as opaque JSON content
(`run-agent-loop.ts:162,189`), truncated at 16 KB (`run-agent-loop.ts:52`) — they
inform the next turn but don't execute.

**Prompt injection via retrieved/recalled content — the real surface.** Both
indexed docs and recalled memory flow into context as tool output with no
sanitization gate. A poisoned document could try to steer the model. Why it's
low-blast-radius here: the worst a hijacked agent can do is call
`search_knowledge_base` again (read-only) or emit bad text to the operator's own
screen — there's no privileged tool to pivot into, no exfiltration channel (no
outbound tool, Ollama is local), and turns are bounded. Deep walk:
`03-indirect-prompt-injection-surface.md`.

**Data exfiltration through tool calls:** `not yet exercised` as a threat — the
only tool reads the local store and returns to the local model. There's no tool
that sends data anywhere.

---

## 8. Security red-flags audit (capstone checklist)

Marked against this repo. `app_id` numbers are illustrative location anchors.

| Red flag | Fires? | Where | Severity | One-line fix / why acceptable |
|---|---|---|---|---|
| String-built SQL with user input | **No** | all sinks parameterized (`src/pg-vector-store.ts:47,70`) | — | Control holds; keep it |
| Secret in source / client bundle / logs | **No** | `.env` gitignored (`.gitignore:2`), `.env.example` empty | — | Hygiene correct |
| Full-privilege client-held credential | **Fires (deferred)** | `DATABASE_URL`, `src/session.ts:35` | Med (phone phase) | Scoped role + short-lived creds when remote |
| Endpoint checks logged-in but not allowed | **N/A** | no endpoints, no auth | — | No remote caller yet |
| Tenant isolation not enforced (no RLS) | **Fires (deferred)** | `app_id` shape only, `sql/001_agents_schema.sql` | Med (multi-tenant phase) | Add RLS keyed on `app_id`/`user_id` |
| Tenant key not token-derived | **Fires (deferred)** | `app_id` from env default `'laptop'` (`src/config.ts:13`) | Med | Derive from auth token in remote phase |
| Memory/docs share store, no metadata-scoped read | **Fires (low)** | `src/session.ts:53` | Low | Today single-tenant; RLS closes it later |
| Agent tool scope exceeds task | **No** | one read-only tool (`ragQueryToolPolicy`) | — | Least privilege holds |
| Model output flows into a sink ungated | **No** | `finalText` is a string to TTY (`src/session.ts:62`) | — | Never eval'd / run |
| Unsanitized retrieved content in prompt | **Fires (low)** | docs + memory as tool output (`run-agent-loop.ts:189`) | Low | Bounded by one read-only tool + capped turns |
| No lockfile | **No** | `package-lock.json` present | — | Reproducible installs |
| Known CVEs unpatched / no audit | **Unknown** | no CI `npm audit` (`.github/workflows` absent) | Low | Add `npm audit` step in CI |
| No rate limiting | **N/A** | single operator, no network ingress | — | Phone-phase concern |
| No secret rotation | **Fires (deferred)** | static `.env` string | Low | Vault + rotation in remote phase |
| Verbose error to caller | **No (acceptable)** | `chat.tsx:31` to own TTY | — | Operator entitled to own errors |

**The single worst exposure today:** none is reachable by a remote attacker,
because there is no remote attacker. The highest-leverage *forward* item is the
full-privilege client-held credential (`DATABASE_URL`) — it's the control that has
to change first the moment buffr stops being single-device, and it pairs with RLS
to make multi-tenant safe.

# Study — Security (buffr-laptop)

The trust axis, made into an audit. One question runs through every file here:

> **what can an attacker reach, and what happens when they do?**

This repo is a single-device laptop RAG agent. There is no server, no
network listener, no second user. That shapes the whole audit: most of the
classic web attack surface (request bodies, auth tokens, CORS, session
fixation) is **not yet exercised** — there is no boundary for it to cross.
The real findings live in three places: the SQL sink, the tenant-isolation
*shape*, and the LLM/agent path where indexed documents flow back into the
model's context.

## Trace the trust axis across the boundaries

```
  buffr-laptop — where untrusted input enters

  ┌─ Operator (you, the laptop user) ───────────────────────────┐
  │  argv: "your question"   ·   .md files you choose to index   │  TRUSTED
  └───────────────────────────┬─────────────────────────────────┘
                              │  no auth — single device
  ┌─ Node process ───────────▼─────────────────────────────────┐
  │  CLI (ask/index/eval)  →  PgVectorStore  →  RagQueryAgent    │
  └──────┬───────────────────────────┬──────────────────┬───────┘
         │ parameterized SQL         │ HTTP             │ prompt + tool results
         ▼                           ▼                  ▼
  ┌─ Postgres (reindb) ┐   ┌─ Ollama :11434 ┐   ┌─ Gemma 2 (LLM) ───────────┐
  │  agents.* tables   │   │  local models   │   │  reads indexed doc text   │ ← real
  │  full-privilege    │   │  no secret      │   │  as data (injection       │   surface
  │  DATABASE_URL      │   │                 │   │  surface)                 │
  └────────────────────┘   └─────────────────┘   └───────────────────────────┘
```

The seams that carry a real trust decision: the **SQL boundary** (is the
query parameterized?), the **tenant boundary** (does `app_id` actually
isolate anyone?), and the **LLM context boundary** (does indexed content
get treated as data or as instructions?). Everything else is `not yet
exercised` because the single-device shape hasn't built the boundary yet.

## Reading order

1. **`audit.md`** — Pass 1. The 8-lens walk. Start here for the full map of
   what fires, what doesn't, and what's honestly deferred.
2. **`01-parameterized-sql-boundary.md`** — the one control the repo gets
   unambiguously right: every SQL sink is parameterized, including the
   pgvector literal. Read this to see what injection-resistance looks like.
3. **`02-shape-only-tenant-isolation.md`** — `app_id` is everywhere in the
   schema and every query, but it's a default constant, not a token-derived
   identity, and there's no RLS. The isolation is shaped but not enforced.
   The most important deferred finding.
4. **`03-indirect-prompt-injection-surface.md`** — indexed documents flow
   back into the model's context as tool results. The classic RAG injection
   surface. Low blast radius today because the only tool is read-only search.
5. **`04-least-privilege-tool-scope.md`** — the agent can call exactly one
   tool, enforced by an allowlist policy and a hard call budget. The control
   that keeps the prompt-injection blast radius small.

## Cross-links to the other study guides

The trust axis touches three other guides. Where a finding is really about
*structure* or *flow* rather than *trust*, it belongs to them:

- **`study-data-modeling`** — the `app_id` column, the missing FK on
  `agents.chunks`, the JSONB `meta` shape. The audit here asks whether
  `app_id` *isolates*; data-modeling asks whether it's *modeled* well.
  → `02-shape-only-tenant-isolation.md` cross-links here.
- **`study-system-design`** — the request/index flow, the
  canonical-Postgres boundary, the provider abstraction over Ollama. The
  audit here asks what an attacker reaches across those hops.
- **`study-agent-architecture`** — the ReAct loop, the tool registry, the
  trajectory-capture sink. The audit here asks what the agent is *allowed*
  to do and what its tool output is *trusted* to be.
  → `03-` and `04-` cross-link here.

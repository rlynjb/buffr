# Study — Security (buffr-laptop)

The trust axis, made into an audit. One question runs through every file here:
**what can an attacker reach, and what happens when they do?** Trace it across
every boundary — where untrusted input enters, who's allowed past, what's hidden
vs exposed, what the dependencies drag in.

For a single-device laptop brain (`reindb`, schema `agents`, Ollama on
`localhost`) the honest answer is: the attack surface is small and the controls
that *are* present are deliberate. Two of them — parameterized queries (the SQL
boundary) and least privilege (the single read-only tool) — are real, load-bearing
controls. Two of the loudest gaps — row-level security (RLS) and authentication —
are not bugs; they're correctly deferred to the phone/edge phase. This guide names
which is which.

## The trust axis in one frame

```
  buffr-laptop — trace "what can an attacker reach?" down the stack

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  Ink chat (src/cli/chat.tsx) — operator types at a TTY    │
  │  trust: the operator IS the owner. No remote caller yet.   │
  └───────────────────────────────┬───────────────────────────┘
                                  │  in-process call
  ┌─ Service layer ───────────────▼───────────────────────────┐
  │  ChatSession (src/session.ts) → RagQueryAgent (aptkit)     │
  │  agent loop, bounded: maxTurns 6 / maxToolCalls 4          │
  │  ONE allowlisted tool: search_knowledge_base (read-only)   │
  │  ◄── indexed docs + recalled memory re-enter as tool output│  ← injection surface
  └───────────────────────────────┬───────────────────────────┘
                                  │  parameterized SQL ($1::vector)
  ┌─ Storage layer ───────────────▼───────────────────────────┐
  │  Postgres + pgvector (reindb.agents)                       │
  │  app_id on every table — SHAPE only, no RLS, not token-tied │  ← tenant gap
  │  DATABASE_URL = full-privilege creds in .env (gitignored)  │  ← client-credential
  └───────────────────────────────┬───────────────────────────┘
                                  │  local HTTP, no key
  ┌─ Provider layer ──────────────▼───────────────────────────┐
  │  Ollama on localhost:11434 (gemma2:9b, nomic-embed)       │
  └────────────────────────────────────────────────────────────┘
```

## Reading order

1. **`audit.md`** — Pass 1. The 8-lens security audit, every lens walked or
   marked `not yet exercised`, capped by the red-flags checklist. Start here.
2. **`01-parameterized-sql-boundary.md`** — the injection-resistant SQL seam.
   Every sink uses `$1`-style placeholders; user text never concatenates into a
   query string. The control that holds.
3. **`02-least-privilege-tool-scope.md`** — the agent is allowlisted to ONE
   read-only tool by `ragQueryToolPolicy`. Bounded turns. The reason the next
   pattern's blast radius is small.
4. **`03-indirect-prompt-injection-surface.md`** — indexed docs *and* recalled
   conversation memory re-enter the prompt as tool results. The surface, why it's
   real, why it's low-blast-radius here.
5. **`04-shape-only-tenant-isolation.md`** — `app_id` on every table, but no RLS
   and not token-derived. The gap named, and why it's correct for the laptop phase.

## What's deliberately not exercised yet

Authentication, authorization, row-level security, rate-limiting, secret
rotation, and dependency-audit/CI. None are bugs at single-device scale — they're
the phone/edge phase's work. `audit.md` names each with the buildable target.

## Cross-links to the rest of the study set

- **Data modeling** (`.aipe/study-data-modeling/`) — the `agents` schema shape,
  the dropped FK, `app_id` as a column. Security reads the *same* schema through
  the trust lens: who may read/write these rows, not how they're structured.
- **System design** (`.aipe/study-system-design/`) — the request flow, the
  local-first storage story, the provider boundary. Security is the threat-model
  overlay on that architecture.
- **Agent architecture** (`.aipe/study-agent-architecture/`) — the RagQueryAgent
  loop, tool registry, retrieval-based memory. Security audits its tool scope and
  its untrusted-content surface.

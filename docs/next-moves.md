# buffr — Next Moves

Roadmap of deferred work for the personal-agent system. The laptop brain is **built and
in use** (single-user, on reindb pgvector); everything below was intentionally deferred.

- **Built:** see `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`
  and its plan. buffr consumes aptkit via `@rlynjb/aptkit-core` from npm.
- **Status today:** `index` / `ask` / `eval` work end-to-end against real Gemma + nomic +
  reindb. Single device, single user, no isolation enforced.

Items are grouped by what they unlock. Each notes **what / why / where it lives / prereqs**.

---

## A. Before sharing it (unblock multi-app / multi-user)

These are the hard prerequisites before a second app or user touches the agent layer.

### A1. Enforce RLS on the `agents` schema
- **What:** Row-level security on `agents.*`, keyed by `app_id` derived from the auth token
  (never trusted from the client). Add policies `USING (app_id = current_setting('request.jwt.claim.app_id'))`.
- **Why:** Today isolation across `app_id` is **by convention only** — any caller can read/write
  any app's rows. This is the single blocker before app #2.
- **Where:** buffr — a new SQL migration + auth wiring (JWT with `app_id` claim).
- **Prereqs:** decide how callers authenticate (Supabase auth / service key per app).

### A2. Edge Functions API layer
- **What:** HTTP endpoints (`/agents/search`, `/agents/documents`, `/agents/conversations`)
  wrapping the same SQL the laptop runtime uses, so other apps call the agent over HTTPS
  instead of importing it.
- **Why:** The "centralized agent layer, many apps" goal. Direct `pg` is fine for one local
  client; apps need an API.
- **Where:** buffr — `supabase/functions/`. The plan deferred this explicitly ("direct now,
  API later").
- **Prereqs:** A1 (RLS), since the API is the multi-tenant entry point.

---

## B. Robustness / reliability

Make the single-device tool harder to break.

### B1. Cloud fallback when Ollama is down
- **What:** Wrap the Gemma provider in `@aptkit/provider-fallback` with a cloud model
  (Claude/GPT) behind it, so `ask`/`index` degrade gracefully instead of failing when Ollama
  isn't running.
- **Why:** Today the buffr CLI has a hard dependency on local Ollama; if it's down, everything
  fails.
- **Where:** buffr — wire the fallback chain in `src/cli/ask-cmd.ts` (the providers already
  exist in aptkit). Needs an API key in `.env`.

### B2. Reindex for embedder swaps
- **What:** A `reindex(embedder)` operation that re-embeds the whole corpus when the embedding
  model changes; the `agents.chunks.embedding_model` column already tracks which model produced
  each vector.
- **Why:** Embedding dimension is a one-way door — a corpus embedded at nomic's 768 can't be
  searched by a different-dimension model. Swapping requires re-embedding.
- **Where:** buffr (a CLI `reindex` command) + possibly a helper in `@aptkit/retrieval`.

### B3. Harden CLI config + errors
- **What:** Validate env/config up front with clear messages; handle partial-failure during
  bulk `index`; consider batch reindex past ~10k chunks (HNSW rebuild cost).
- **Why:** It's currently CLI-grade — bad config throws raw errors.
- **Where:** buffr — `src/config.ts`, the CLI entrypoints.

---

## C. The body (bigger phases — the deferred architecture)

The two-brain laptop+phone vision. Build order: **laptop brain first (done) → phone second.**

### C1. Phone brain
- **What:** A React Native app with an on-device model (Gemini-Nano-class) running its own
  agent loop, reading/writing the same `agents` schema in reindb.
- **Why:** "An agent that lives across your surfaces." The phone *asks*; the laptop does the
  heavier *acting* (asymmetric brains).
- **Where:** a new RN app repo. Reuses the `agents` schema and the Edge Functions API (A2).
- **Prereqs:** A1, A2.

### C2. Laptop ↔ phone memory sync
- **What:** Sync/merge model for conversation + profile state across two live brains (the
  buffr canonical-local-with-cloud-mirror pattern).
- **Why:** Two brains, one memory = a merge problem. Only bites once both brains are live.
- **Where:** buffr / shared plane. **Solve second**, after the phone brain exists — so sync is
  the second problem, not the first.

### C3. Multi-platform gateway
- **What:** One process fronting Telegram / Discord / Slack / CLI — "start a conversation on
  one surface, continue on another."
- **Why:** Reach. Borrowed from Hermes, but only if there's a real need.
- **Where:** new service. Skip until warranted.

### C4. Trajectory → fine-tune
- **What:** Export `(conversation_id, messages[], outcome)` from `agents.messages` to JSONL;
  consider LoRA/QLoRA on Gemma **only** if Phase-4-style eval evidence justifies it.
- **Why:** The MLOps loop. Trajectories are already captured from day one — this is the asset
  that makes "should I fine-tune?" answerable later.
- **Where:** buffr (export job) + a separate training pipeline. The furthest the project would
  ever go; never pre-train.

---

## Suggested order

1. **B1** (Ollama fallback) — cheap, removes the most likely day-to-day breakage.
2. **A1 → A2** (RLS → API) — the gate to sharing the agent with other apps.
3. **B2 / B3** — as the corpus and usage grow.
4. **C1 → C2** — when you actually want the phone surface.
5. **C3 / C4** — only on evidence/need.

Anything in C is a real architecture decision; revisit the body sketch in the graduation spec
before starting it.

# 06 · Production Serving

**Phase 5 of the AI-engineering curriculum.** This is the layer between "the agent answers correctly in a notebook" and "the agent stays up, stays cheap, and stays safe under real traffic." Everything before this — foundations (01), prompts (02), retrieval (03), the agent loop (04), evals (05) — assumes one well-behaved request at a time. Production serving is what happens when requests *stack*, *repeat*, *fail*, or *attack*.

This sub-section is anchored to **buffr-laptop** — a local RAG agent: `gemma2:9b` for generation, `nomic-embed-text:v1.5` (768-dim) for embeddings, Postgres + pgvector for retrieval, an Ink TUI for chat. Generation runs through `GemmaModelProvider` (in aptkit), wrapped by `ContextWindowGuardedProvider`; the whole session is wired in `src/session.ts`.

Read this section with one fact held front of mind: **buffr is local, single-device, single-user.** That is not an excuse — it is the architecture. Several "production serving" concerns that are load-bearing for a multi-tenant cloud service are *honestly N/A or not-yet-built* here, and the cost optimization story is about *latency and compute*, not dollars, because Ollama is free and local. Each file says plainly whether the concept is **built**, **partial**, or **Case B** (the slot exists, the code doesn't), and turns every gap into a buildable exercise. Do not let a clean diagram fool you into thinking a thing ships.

## Reading order

Read top to bottom — each file assumes the one before it.

| # | File | Phase anchor | What it locks in |
|---|------|--------------|------------------|
| 01 | `01-llm-caching.md` | C5.1 | Three cache layers (exact / semantic / prompt). Buffr caches *nothing* at serve time — it re-embeds and re-runs every turn. **Case B.** Closest live thing: index-time embedding reuse. |
| 02 | `02-llm-cost-optimization.md` | C5.2 | Cheap-model-first routing. Dollars are N/A (Ollama is local/free); the real cost is **latency + compute**. Single model, no routing. **Case B.** Measurement substrate: token capture. |
| 03 | `03-prompt-injection.md` | C5.3 | **The real risk surface.** Profile + retrieved chunks are injected as plain text with no privileged channel. Defenses buffr HAS (least-privilege tools, no direct side effects) vs LACKS (no sanitization, no output check). **Partial.** |
| 04 | `04-rate-limiting-backpressure.md` | C5.4 | Queue + concurrency cap. N/A for one local user, but Ollama can be saturated. **Case B.** Closest live thing: the `busy` flag in `chat.tsx`. |
| 05 | `05-retry-circuit-breaker.md` | C5.5 | Backoff retry + breaker on a flaky dependency. **Partial:** one retry on botched tool-call JSON (`maxToolCallAttempts`), best-effort memory write. No HTTP backoff, no breaker. |

The phase anchors C5.6–C5.8 (autoscaling, multi-region, blue-green deploy) have *no* buffr surface — a single laptop process does not autoscale or fail over. They are named here for completeness and live in the system-design templates (07), not as concept files, because there is no code to anchor them to.

## The honest map

One concept is **partial** and built enough to defend in an interview (03 — prompt injection; the least-privilege tool policy and the no-direct-side-effects property are real, shipped decisions). One is **partial** in a narrower sense (05 — there is exactly one retry, of exactly one thing). The other three (01, 02, 04) are **Case B**: the architecture leaves a clean slot, but no code fills it yet. That is the correct call for a single-device local agent — and each file names the *exact* trigger ("if buffr ever serves more than one user / one device / over a network") that flips the concern from N/A to required.

The most important file in this section is **03**. Caching, cost, and rate-limiting are quality-of-life. Prompt injection is the one place where buffr's architecture has a genuine, exploitable seam *today*, on a single laptop, with no network attacker required — a malicious indexed document is enough. Read it last but weight it first.

## Cross-links

- **`../01-llm-foundations/07-heuristic-before-llm.md`** — the cheap-path gate that 01 (caching) and 02 (routing) both build on. Skipping the LLM is the cheapest cache there is.
- **`../01-llm-foundations/06-token-economics.md`** — the token ledger that 02's cost story measures against.
- **`../05-evals-and-observability/`** — the trace sink (`SupabaseTraceSink`) that captures `model_usage` is the *measurement substrate* for everything in 02, and the place a safety-check eval (03) would live.
- **`../../study-security/`** — the full trust-boundary treatment of 03. This file is the AI-eng slice; that audit is the whole perimeter.
- **`../../study-runtime-systems/`** — bounded work, cancellation, and backpressure (04) as a runtime-execution concern, not just an AI one.

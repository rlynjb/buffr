# 06 — Production Serving (LLM side)

**Anchor:** LLM application engineering. **Curriculum:** Phase 5.

Read this first, because it sets the honest frame for the
whole section: **buffr is a local, single-device, single-user
RAG agent.** One user runs `npm run chat`, Ollama serves
`gemma2:9b` and `nomic-embed-text:v1.5` on `localhost`, Postgres
holds the vectors. There is no provider you pay per token, no
shared cache, no multi-tenant load, no fleet of replicas.

That means **most of production-serving is NOT YET EXERCISED in
buffr.** This section is mostly study material plus concrete
Case-B exercises — "here's the production concern, here's the
one place in buffr where it'd actually attach if you grew the
system." We're direct about that in every file. Pretending buffr
has a rate limiter it doesn't would be the opposite of useful.

```
  buffr's serving topology — why most of this section is dormant

  ┌─ One device (the laptop) ───────────────────────────────────┐
  │                                                              │
  │  npm run chat ──► createChatSession ──► agent.answer()       │
  │       │                                      │               │
  │       │ serial: one question at a time       │               │
  │       ▼                                      ▼               │
  │  Ollama @ localhost:11434         Postgres + pgvector        │
  │  gemma2:9b · nomic-embed-text     (local)                    │
  │                                                              │
  │  no network provider · $0 per token · 1 user · no queue      │
  └──────────────────────────────────────────────────────────────┘
        every production-serving concern below assumes the
        opposite of this picture — that's why they're dormant
```

## Reading order

1. `02-llm-cost-optimization.md` — **the richest file**, because
   the observability substrate genuinely exists: buffr persists
   `tokens_used` per call (`src/supabase-trace-sink.ts:73-78`).
   Locally "cost" = latency + tokens, not dollars. Partially
   exercised.
2. `03-prompt-injection.md` — partially relevant. The profile
   (`me.md`) and retrieved chunks flow into the prompt
   unsanitized, and the tool-call path isn't guarded against the
   model emitting an action it shouldn't.
3. `01-llm-caching.md` — buffr has no cache anywhere. Case B:
   exact-match cache on a single user is trivially correct;
   semantic cache over the embedding is the richer version.
4. `04-rate-limiting-backpressure.md` — the one real
   backpressure-shaped guard is `ContextWindowGuardedProvider`
   (`src/session.ts:46`). No queue, serial by construction.
5. `05-retry-circuit-breaker.md` — buffr has neither. The
   best-effort memory swallow (`src/session.ts:64-70`) is the
   closest resilience pattern, but it's "give up," not "retry."

## Exercised vs not

**Exercised (real, in `src/`):**
- **Cost observability substrate** — per-call `tokens_used`
  captured into `agents.messages`
  (`src/supabase-trace-sink.ts:73-78`). The prerequisite for any
  cost work.
- **One backpressure-shaped guard** —
  `ContextWindowGuardedProvider` refuses oversized input rather
  than overflowing the 8192-token window (`src/session.ts:46`).
- **Natural backpressure** — serial, one-conversation-at-a-time
  execution; the UI blocks input while `busy`
  (`src/cli/chat.tsx`).
- **One best-effort resilience pattern** — the memory-write
  try/catch swallow (`src/session.ts:64-70`).

**Not yet exercised (study + Case B):**
- **Caching** — no exact-match, semantic, or prompt cache
  anywhere in `src/`.
- **Cost routing** — no cheap-model-first / skip-retrieval
  routing; every query takes the full path.
- **Prompt-injection defense** — profile + chunks are
  unsanitized; no output-side tool-call guard.
- **Rate limiting / queueing** — no queue, no concurrency cap on
  Ollama.
- **Retry / circuit breaker** — no retry-with-backoff, no
  breaker around Ollama calls.

Every file below is honest about which side of that line its
concept sits on, and gives a Case-B exercise on real buffr
files.

## A note on Case A vs Case B

These exercises are mostly **Case B** — "the concern isn't
exercised yet; here's how to make it apply if buffr grew."
There's no curriculum file driving exercise IDs, so the IDs are
derived from each file's concept, not from a `[Bx.y]` index.

## See also

- `../05-evals-and-observability/04-llm-observability.md` — the
  trajectory trace that already captures `tokens_used`; the
  shared substrate this section builds cost work on.
- `../04-agents-and-tool-use/02-tool-calling.md` — the
  unvalidated tool-call seam that `03-prompt-injection.md`
  cross-links as buffr's strongest real defense.
- `../01-llm-foundations/06-token-economics.md` — tokens as the
  unit of both cost and latency.

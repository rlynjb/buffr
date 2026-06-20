# Centralized Agent Layer — Plan

A self-hosted, **single** RAG agent built on [AptKit](../aptkit), running **off-the-shelf Gemma**, backed by **Supabase** (centralized data + pgvector), exposed over a stable HTTP API that any of my apps (`buffr`, `blooming_insights`, `contrl`, …) can call.

This is a **learning + portfolio project**. The deliverable is one good agent with *measured* eval numbers — not a platform.

> Full per-phase detail (schema columns, table definitions, the original long-form plan) lives in `aptkit/docs/gemma-rag-supabase-plan.md`. This document captures the **decisions** that refine it.

---

## What this is (in one line)

> A **single off-the-shelf-Gemma RAG agent** on AptKit's runtime, **centralized** on Supabase — borrowing Hermes Agent's *trajectory-capture discipline* but none of its platform machinery or its fine-tuned models.

### What it is NOT

- **Not Hermes.** Hermes Agent is a multi-agent Python *platform* (sub-agents, skill auto-generation, multi-platform gateways) running Nous Research's own **fine-tuned** models (Hermes = fine-tunes of Llama/Mistral/Qwen). This project runs **stock Gemma 2**, in TypeScript, and only steals the *patterns* — above all, capture every conversation as a trajectory now so fine-tuning is *answerable* later, not assumed.
- **Not a fleet of agents.** Ship ONE agent end-to-end, measure it, then maybe generalize. (AptKit's 5 packaged agents are templates, not the product.)
- **Not fine-tuned (yet).** Fine-tuning (LoRA/QLoRA on Gemma) is the *furthest* this would ever go, and only if Phase 4 evidence demands it. Never pre-train.

---

## Why build it instead of using Hermes (the portfolio thesis)

A turnkey tool hides exactly the parts that signal engineering skill. Building this route exposes them:

- A **provider contract + real implementation** — write the Gemma `ModelProvider`, tame its messy JSON via AptKit's `structured-generation`.
- A **RAG pipeline I actually built** — chunking, embeddings, pgvector + HNSW, retrieval ranking.
- A **multi-tenant centralized service with RLS** — systems design, not prompt-tinkering.
- **Evals with numbers** — precision@5, faithfulness (rubric judge), JSON validity rate. The biggest separator between "played with an LLM" and "does AI engineering."
- A **measurement-driven decision** (ship vs. iterate vs. fine-tune) made *from* evidence.

**The Phase 4 one-pager (eval numbers + failure breakdown + next action) is the portfolio artifact.** The write-up matters as much as the code.

Balance: build the **glue and the judgment layer**. Don't reinvent the agent loop or vector search — that costs scope and hides the interesting parts. Use AptKit, use Gemma off-the-shelf, use pgvector.

---

## Where the code lives (decided)

Split by *kind of thing*, not by feature:

| Component | Where | Why |
| --- | --- | --- |
| `packages/providers/gemma`, `packages/retrieval` | **In AptKit** | Library code implementing AptKit's `ModelProvider` / tool-registry contracts. Reusable, deployment-agnostic. Sits next to `providers/local`. |
| `agents` schema (migrations), Supabase Edge Functions, embedding pipeline, deploy config, the Node runtime process | **The agent service** (this repo / a service repo) | A *running service* with a URL, secrets, an Ollama box, RLS. None of that is AptKit's job. |
| `buffr`, `blooming_insights`, `contrl` | **Their own repos** | Consume the agent over **HTTP only**. Never touch `agents.*` tables or AptKit internals. |

**Why not all-in-AptKit:** AptKit is a provider-agnostic, library-first toolkit (that's why `providers/` has anthropic/openai/local side by side). Putting Supabase migrations + Ollama deploy config inside it would turn the toolkit into "the Gemma+Supabase app" and kill its reuse across apps.

**Why not all-in-its-own-repo:** that means forking/vendoring AptKit's runtime, defeating the "AptKit is 70% of what you need" premise. The Gemma provider and retrieval tool genuinely *are* AptKit extensions.

**Consumption seam (one decision left):** how the service consumes AptKit — published package, git dependency, or a **workspace monorepo holding both AptKit + the service**. Given one developer and heavy co-evolution through Phases 1–4, the monorepo is the pragmatic default (one PR per feature; can still publish AptKit separately later).

---

## Architecture

```
  Apps (buffr, blooming_insights, contrl, …)
    │  call agent endpoints via HTTPS (app key in JWT) — never raw SQL
    ▼
  Supabase Edge Functions (the agent API)
    POST /agents/search                  (vector retrieval)
    POST /agents/documents               (write + chunk + embed)
    POST /agents/conversations           (start session)
    POST /agents/conversations/:id/messages (append turn)
    GET  /agents/conversations/:id       (read history)
    │                                   │
    ▼                                   ▼
  Supabase Postgres                     AptKit runtime (Node)
   public  (Supabase auth)               - run-agent-loop (bounded)
   app_*   (existing apps, untouched)    - structured-generation
   agents  (NEW; pgvector + HNSW)        - providers/gemma   (NEW)
     .documents .chunks .conversations   - retrieval tool    (NEW)
     .messages .tool_runs                          │
                                                   ▼
                                          Ollama (local box)
                                            gemma2:9b (generation)
                                            nomic-embed-text (768-dim)
```

**Centralize the *agent layer*, not the *data*.** Existing per-app schemas stay where they are. The `agents` schema holds only RAG infrastructure (corpus copies, chunks, conversations, tool cache). Apps write *into* `agents.documents` with their `app_id` when they want something indexed.

**Isolation:** one API key / JWT (`app_id` claim) per app; RLS on every `agents.*` table (`USING (app_id = current_setting('request.jwt.claim.app_id'))`); `app_id` is **always** derived from the token, never the request body.

---

## Phase plan (~4 weeks, each phase ends in a hand-testable artifact)

**Phase 1 — Provider + storage foundation.** Ollama + `gemma2:9b` + `nomic-embed-text`. Write `packages/providers/gemma` (model the context-window guard after `providers/local`). Prove the bounded agent loop runs against Gemma and `structured-generation` survives Gemma's worse JSON — *this is the riskiest piece; de-risk it first.* Create the `agents` schema, 5 tables, HNSW index (cosine), RLS.

**Phase 2 — Centralized API.** Edge Functions for `/documents` (chunk + embed + insert), `/search` (embed query → app-scoped vector search → cited chunks), conversations, and tool-run cache. Hand-test by POSTing one markdown file per app. Build a 20-item eval set; require **precision@5 ≥ 0.8** before Phase 3.

**Phase 3 — Agent integration.** `packages/retrieval` wraps `/agents/search` as a `search_knowledge_base` tool. Compose a RAG variant of `packages/agents/query` (Gemma + retrieval tool, no loop changes). Persist every `assistant`/`tool` trace event to `agents.messages`. Wire tool-run caching.

**Phase 4 — Measure, then decide.** Run AptKit's `eval-harness`: precision@5, faithfulness (rubric judge), JSON validity. Categorize failures (retrieval miss / bad synthesis / model gap). Decide: ≥80% → ship; 50–80% retrieval-bound → improve retrieval; 50–80% model-bound → escalate via fallback chain, consider fine-tuning only if the failure pattern is narrow and Phase-3 trajectories can supply data; <50% → architecture problem, don't paper over with training.

---

## What NOT to do

1. Don't pre-train. Fine-tuning is the ceiling, and only after Phase 4 evidence.
2. Don't use Gemma for embeddings — use `nomic-embed-text-v1.5` (purpose-built > generation model).
3. Don't index every write synchronously at scale — batch reindex past ~10k chunks.
4. Don't trust `app_id` from clients — derive from JWT; RLS is defense-in-depth.
5. Don't centralize *data*; centralize the *agent layer*.
6. Don't ship a "platform" before one good agent works end-to-end.
7. Don't conflate evals (good answers) with tests (loop runs). Both needed.

---

## Open questions (decide before Phase 2 — most are one-way doors)

- **Embedding dimension.** `nomic-embed-text-v1.5` = 768-dim. Switching later to OpenAI (1536) / Voyage (1024) means a painful migration. Pick now.
- **Chunking.** Fixed-size (512 tok, 64 overlap) vs. semantic. Default fixed for v1; revisit in Phase 4 if retrieval misses dominate.
- **Edge Function vs. PostgREST RPC** for vector search. Start with Edge Functions; move hot paths to a `search_chunks(...)` RPC after Phase 4 numbers.
- **Conversation retention.** Unbounded growth is a real cost. Decide TTL / keep-N-recent / archive now.
- **Cross-app retrieval.** Default: no, strict app isolation. Enabling it later is an explicit policy decision.

---

## Name

Working repo is **`buffr`**. If the agent layer wants its own identity, candidates (pick one that's unique enough to be the top Google hit):

- **Atrium** *(recommended)* — a central space everything connects through; pairs with `aptkit` without copying it.
- **Hearth** — self-hosted, central, warm (a nice foil to Hermes the cloud "god").
- **Mnemo** — from Mnemosyne (memory); leans into the trajectory-capture thesis that is this project's real differentiator.

---

## Done means

Phases 1–4 checked off and a written one-pager with eval numbers, a failure-category breakdown, and a chosen next action. The agent runs, retrieves, generates with Gemma, persists everything to Supabase, and there's *measured evidence* about whether it's good enough to ship or what specifically needs to improve. Everything beyond that (fine-tuning, multi-platform gateways, skill auto-generation) is a Phase 5+ decision made *from* evidence, not toward it.

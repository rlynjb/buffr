# AI Engineering Study Guide — buffr

> Updated: 2026-06-24 — reconciled to the `chat`/`session.ts` surface (`ask` retired); added `08-conversation-memory.md` (retrieval-based episodic memory via `@aptkit/memory`); noted `tokens_used` now persisted and the full 6-event trace.

Audit-style, two-pass guide for buffr's AI engineering. buffr is a TypeScript laptop RAG agent: Ollama `gemma2:9b` generation + `nomic-embed-text` embeddings, Postgres+pgvector retrieval, a bounded agent loop with tool-calling, retrieval-based episodic memory over chat history, and offline retrieval evals — all via `@rlynjb/aptkit-core` (0.4.1), with buffr adding the pg persistence + an interactive `chat` surface.

Shape: **LLM application engineering** (not classical ML). The guide audits buffr's *use* of the toolkit, not the toolkit itself.

## Reading order

1. **`00-overview.md`** — the whole system in one diagram, the eight seams, which shape this is.
2. **`audit.md`** — Pass 1. Every lens from the AI-eng spec, with `file:line` or `not yet exercised`. Start here for "where is X and is it even here."
3. **Pattern files** — Pass 2, the load-bearing patterns, in this order:
   - `01-rag-index-path.md` — chunk → embed → pgvector upsert (write side).
   - `02-rag-query-path.md` — embed → ANN cosine → rank → ground (read side).
   - `05-embedding-model-choice.md` — nomic 768-dim as a one-way door (constrains both paths).
   - `03-agent-loop-with-tool-calling.md` — bounded turns, forced synthesis (generation outer loop).
   - `04-gemma-tool-call-emulation.md` — stock Gemma has no native tools; THE risk (generation inner seam).
   - `07-profile-as-context.md` — `me.md` injected into the system prompt.
   - `08-conversation-memory.md` — RAG over chat history; retrieval-based episodic memory (`@aptkit/memory`).
   - `06-evals-precision-and-recall.md` — offline retrieval scoring, and the faithfulness gap.
4. **`07-system-design-templates/`** — interview reframes (search-ranking, tech-support-chatbot), 9-bullet shape, both `partially` for buffr.
5. **`ai-features-in-this-codebase.md`** / **`ml-features-in-this-codebase.md`** — the per-feature tables (ML file: honestly empty, buffr has no classical ML).

## File map

```
  .aipe/study-ai-engineering/
    README.md                              ← you are here
    00-overview.md                         ← orientation
    audit.md                               ← Pass 1: lens sweep
    01-rag-index-path.md                   ┐
    02-rag-query-path.md                   │
    03-agent-loop-with-tool-calling.md     │ Pass 2:
    04-gemma-tool-call-emulation.md        │ load-bearing
    05-embedding-model-choice.md           │ pattern files
    06-evals-precision-and-recall.md       │
    07-profile-as-context.md               │
    08-conversation-memory.md              ┘ ← episodic memory (RAG over chat)
    07-system-design-templates/
      01-search-ranking.md                 ← interview reframe (partially)
      02-tech-support-chatbot.md           ← interview reframe (partially)
    ai-features-in-this-codebase.md        ← per-feature table
    ml-features-in-this-codebase.md        ← honestly empty (no classical ML)
```

## The "not yet exercised" ceiling

Named honestly so the gaps are a map: no fine-tuning (the literal ceiling — both models stock; the now-full-signal trajectories are the FT corpus), no reranking, no hybrid/sparse search, no streaming, no caching, no chunking-strategy tuning, no faithfulness/LLM-as-judge eval (despite a `RubricJudge` in the library — still the live evals gap), no token/cost *action* (tokens are now logged via `model_usage`→`tokens_used`, but nothing reads them), no memory *management* (summarization/decay — episodic memory now exists, but its management half is out of scope in `@aptkit/memory`), no prompt-injection defense / rate limiting / circuit breaker, no classical ML. Full grounding in `audit.md`.

## Cross-links to sibling guides

- `.aipe/study-database-systems/` — HNSW, cosine `<=>`, the storage engine under pgvector.
- `.aipe/study-dsa-foundations/` — ANN-vs-exact search, graph-traversal cost (HNSW is a navigable graph).
- `.aipe/study-system-design/` — the architecture view: vector-store adapter, CLI entrypoints, trajectory capture, library-as-dependency boundary, profile injection. Note: the `@aptkit/memory` engine extracted *up* into the toolkit is the architectural counterpart to `08-conversation-memory.md`.
- `.aipe/study-testing/` — the eval seam as testing: fake-embedder injection, env-gated DB tests, contract-parity.
- `.aipe/study-prompt-engineering/` — system-template wording and synthesis instruction (if that generator is run).

## Notes on generation

- No `aieng-curriculum.md` exists in this repo, so Project-exercise blocks name the buildable target directly without `[Bx.y]`/`[Cx.y]` provenance IDs.
- The library `@rlynjb/aptkit-core` is consumed, never edited — so a lens "exercised by the library buffr wires up" counts (buffr made the wiring call), but a capability "available in the library, not wired by buffr" is `not yet exercised` (e.g. the `RubricJudge`).

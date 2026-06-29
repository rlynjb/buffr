# 01 · LLM Foundations

**Phase 1 of the AI-engineering curriculum.** This is the floor everything else stands on: what the model *is*, what flows in and out, and where the load-bearing constraints live. Before retrieval (03) or the agent loop (04) make sense, you have to see the LLM as a single function with a fixed-size mouth and no memory of its own.

This sub-section is anchored to **buffr-laptop** — a local RAG agent: `gemma2:9b` for generation, `nomic-embed-text:v1.5` (768-dim) for embeddings, Postgres + pgvector for retrieval. Generation runs through `GemmaModelProvider` (in aptkit), wrapped by `ContextWindowGuardedProvider`, wired together in `src/session.ts`.

## Reading order

Read top to bottom — each file assumes the one before it.

| # | File | What it locks in |
|---|------|------------------|
| 01 | `01-what-an-llm-is.md` | The model is a pure function: tokens in → tokens out. Most LLM bugs are treating it as more. |
| 02 | `02-tokenization.md` | Text is chopped into tokens; context is a token budget. Buffr reads Ollama's counts, doesn't tokenize itself. |
| 03 | `03-sampling-parameters.md` | Temperature/top-p/top-k shape the output distribution. Buffr sets *none* — Ollama defaults. **Not yet exercised.** |
| 04 | `04-structured-outputs.md` | A typed contract at the LLM boundary. Buffr's only structured path is the emulated tool-call JSON. No Zod. |
| 05 | `05-streaming.md` | Token-by-token vs whole-answer-at-once. Buffr is `stream:false`; the TUI shows a spinner. **Not yet exercised.** |
| 06 | `06-token-economics.md` | The cost ledger. Buffr captures per-call token counts; Ollama is local so $ = 0. No cost dashboard. |
| 07 | `07-heuristic-before-llm.md` | Route cheap before paying the model. Buffr always calls the LLM. **Not yet implemented.** |
| 08 | `08-provider-abstraction.md` | The port/adapter pattern. Swap a provider via one constructor. The **768 one-way door** lives here. |
| 09 | `09-user-override-locks.md` | `_overridden_at` so re-runs don't clobber user edits. Buffr upserts blindly. **Not yet implemented.** |

## The honest map

Four of these concepts are **built and active** in buffr (01, 02, 06, 08). The other five are either **not yet exercised** (03, 05 — the capability exists in the stack but buffr doesn't drive it) or **not yet implemented** (07, 09 — no code path at all). Each file says which, plainly, and turns the gap into a buildable exercise. Do not let a polished diagram fool you into thinking a thing ships.

## Cross-links

- **`../03-retrieval-and-rag/`** — where the 768-dim embeddings from 08 actually get used; the other half of the model boundary.
- **`../04-agents-and-tool-use/`** — the agent loop that *consumes* the tool-call structured output from 04 and the non-streaming completion from 05.
- **`../00-overview.md`** — the whole system in one frame, including the two paths and the emulated-tool-calling ceiling.

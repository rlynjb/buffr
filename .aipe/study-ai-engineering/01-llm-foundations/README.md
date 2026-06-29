# 01 — LLM Foundations

**Anchor:** LLM application engineering · **Curriculum:** Phase 1.

This is the floor everything else stands on. buffr is a local-first RAG agent: Ollama serves `gemma2:9b` for generation and `nomic-embed-text:v1.5` for embeddings, Postgres + pgvector does retrieval, and the agent is a bounded tool-calling loop. These nine files cover what an LLM *is* as an engineering primitive — a function from tokens to tokens — and the machinery buffr wraps around it before you ever get to retrieval or agents.

No curriculum file (`aieng-curriculum.md`) is present, so no `[Bx.y]` IDs are cited. Exercises are derived directly from the buffr codebase.

## Reading order

```
  Foundations, in dependency order

  01 what-an-llm-is ─────► the function: tokens in, tokens out
        │
        ▼
  02 tokenization ───────► what a "token" is, and the ~3 chars/token guard
        │
        ▼
  03 sampling-parameters ► temperature / top-p / top-k (the dials buffr leaves default)
        │
        ▼
  04 structured-outputs ─► schema-as-contract (buffr's is the tool-call JSON)
        │
        ▼
  05 streaming ──────────► token-at-a-time vs await-the-whole-answer (buffr awaits)
        │
        ▼
  06 token-economics ────► the cost ledger: model_usage → messages.tokens_used
        │
        ▼
  07 heuristic-before-llm ► route cheap checks before the model (buffr doesn't)
        │
        ▼
  08 provider-abstraction ► the factory/interface seam + Gemma tool-call emulation
        │
        ▼
  09 user-override-locks ► _overridden_at so a re-run doesn't erase a human edit
```

Read 01→04 in order — each builds on the last. 06 and 08 are the load-bearing files for buffr and deserve the most time. 05, 07, and 09 describe patterns buffr does *not* yet have; read them for the gap and the Case-B exercise.

## The files

| # | File | What it covers | Exercised in buffr? |
|---|------|----------------|---------------------|
| 1 | `01-what-an-llm-is.md` | LLM as a pure-ish function, not a DB or a reasoner | **Yes** — `gemma2:9b` is the brain in the loop |
| 2 | `02-tokenization.md` | text → tokens, ~4 chars/token; the guard's ~3 chars/token estimate | **Partial** — buffr logs real Ollama counts, estimates for the guard |
| 3 | `03-sampling-parameters.md` | temperature / top-p / top-k | **No** — Gemma defaults, no temp set (Case B) |
| 4 | `04-structured-outputs.md` | schema-as-contract; tool-call JSON vs validated `generateStructured` | **Yes (emulated)** — tool boundary unvalidated |
| 5 | `05-streaming.md` | streaming vs non-streaming | **No** — Ink TUI awaits the full string (Case B) |
| 6 | `06-token-economics.md` | the cost ledger; token persistence | **Yes (partial)** — tokens captured, $0 local |
| 7 | `07-heuristic-before-llm.md` | route cheap deterministic checks first | **No** — every question hits the loop (Case B) |
| 8 | `08-provider-abstraction.md` | factory/interface pattern + Gemma emulation | **Yes (deeply)** — the load-bearing file |
| 9 | `09-user-override-locks.md` | `_overridden_at` so re-runs don't clobber edits | **No** — no LLM-written user fields (Case B) |

## See also

- `../00-overview.md` — the whole system in one diagram.
- `../ai-features-in-this-codebase.md` — the AI-feature ledger.
- `../04-agents-and-tool-use/02-tool-calling.md` — the tool-call reliability seam (heavily cross-linked from 04 and 08).
- `../06-token-economics.md` lives here as `06-token-economics.md`; the broader cost story continues in `../06-production-serving/`.

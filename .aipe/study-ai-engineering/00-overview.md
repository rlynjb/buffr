# AI Engineering — buffr-laptop, in one picture

You're studying `buffr-laptop`: the laptop "brain" of a self-hosted personal RAG agent. It's a **local-first LLM application** — Ollama serves both models on your own machine, Postgres + pgvector holds the corpus, and the whole thing graduates an in-memory RAG prototype into something persistent and replayable. No cloud LLM, no managed vector DB, no edge functions. One device, one conversation at a time, through `npm run chat`.

That makes the shape unambiguous. Of the three shapes the AI-engineering spec recognizes — LLM application engineering, prompt-engineering meta-tooling, classical supervised ML — buffr is squarely the **first**. So this guide is weighted toward LLM foundations, retrieval/RAG, agents-and-tool-use, and evals. The classical-ML sections (08, 09) are generated honestly: buffr trains no model, so they're study material plus Case-B exercises, not walkthroughs of your code.

## The whole system in one diagram

Here is every layer the rest of this guide drills into. The `★` boxes are the patterns that earn their own concept files.

```
  buffr-laptop — the full stack, one frame

  ┌─ Interface (Ink TUI) ───────────────────────────────────────┐
  │  src/cli/chat.tsx — one long-lived conversation in-process   │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ask(question)
  ┌─ Session layer ───────────▼─────────────────────────────────┐
  │  src/session.ts — warm pool, agent built once, per-turn:     │
  │   persist user turn → run agent → ★ remember exchange ★      │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Agent layer (aptkit) ────▼─────────────────────────────────┐
  │  RagQueryAgent.answer() → ★ bounded agent loop ★             │
  │   maxTurns=6, maxToolCalls=4, forced synthesis turn          │
  │   profile (me.md) injected into system prompt                │
  │   tool: search_knowledge_base                                │
  │   model: ★ Gemma tool-call emulation ★ (no native tools)     │
  └──────────────┬──────────────────────────┬───────────────────┘
                 │ embed query              │ generate
  ┌─ Retrieval ──▼──────────────┐  ┌─ Generation ▼──────────────┐
  │ ★ query path ★              │  │ Ollama gemma2:9b           │
  │  embed → ANN → rank → cite  │  │ ContextWindowGuard 8192    │
  │ ★ index path ★ (offline)    │  └────────────────────────────┘
  │  chunk → embed → upsert     │
  └──────────────┬──────────────┘
                 │ nomic-embed-text:v1.5 (768-dim)
  ┌─ Storage ────▼──────────────────────────────────────────────┐
  │  Postgres + pgvector, schema `agents`, HNSW cosine           │
  │  chunks (embedding vector(768)) ← docs ← ★ memory (kind=memory)│
  │  conversations / messages ← ★ full trajectory trace ★        │
  │  profiles (me.md)                                            │
  └─────────────────────────────────────────────────────────────┘
```

Read that top-to-bottom and you've seen the argument of the whole repo: a question comes in at the TUI, the session hands it to a bounded agent loop, the loop calls one retrieval tool, the tool embeds and ANN-searches pgvector, the model grounds an answer in what came back — and the exchange is both *traced* (into `messages`) and *remembered* (back into `chunks` as an episodic memory). Every box is a pattern this guide names.

## The one thing to understand first

buffr's reliability ceiling is a single seam: **Gemma has no native tool-calling, so aptkit emulates it** — it renders the tool's JSON schema into the prompt and parses a JSON object back out of the model's free text. There is no argument-schema validation on the way back. If the model emits `{"tool":"search_knowledge_base","arguments":{"q":"..."}}` instead of `{"query":"..."}`, the handler reads `args.query`, finds it missing, coerces it to the empty string, and runs a vector search over `""`. The loop succeeds, the trace looks clean, and the retrieval is garbage. Everything downstream — answer quality, the precision@k eval, the episodic memory you write — inherits that fragility. Hold this in mind; it recurs in `04-agents-and-tool-use/02-tool-calling.md` and `gemma-tool-call-emulation`.

## Reading order

1. **`01-llm-foundations/`** — what the Ollama models are, 768-dim embeddings as a one-way door, token economics now that the trace sink persists usage.
2. **`02-context-and-prompts/`** — the context window guard, profile-as-context, why there's no in-prompt turn history.
3. **`03-retrieval-and-rag/`** — the core. Index path, query path, the full RAG pipeline, episodic conversation memory. This is where buffr lives.
4. **`04-agents-and-tool-use/`** — the bounded loop, tool-calling, Gemma emulation, agent memory, error recovery.
5. **`05-evals-and-observability/`** — precision@k/recall@k (wired), the RubricJudge faithfulness gap (unwired), the trajectory trace.
6. **`06-production-serving/`** — caching, cost, prompt injection, backpressure — mostly *not yet exercised*, framed as next moves.
7. **`07-system-design-templates/`** — reframe buffr as "search ranking" and "tech-support chatbot" interview prompts.
8. **`08-machine-learning/` + `09-ml-system-design-templates/`** — honest study material; buffr trains no model.
9. **`ai-features-in-this-codebase.md` / `ml-features-in-this-codebase.md`** — the per-feature ledger.

## What's not yet exercised (named honestly up front)

Fine-tuning (the ceiling — trajectories in `messages` are the future FT corpus, but no training happens). Reranking. Hybrid / sparse / keyword retrieval (dense-only today). Streaming (the TUI awaits the full answer). Caching (none). Chunking-strategy tuning (fixed 512/64 char windows from aptkit). Faithfulness eval (RubricJudge exists in aptkit but is wired into nothing here). Arg-schema validation at the tool boundary. Each gets a fair hearing where it belongs.

## See also

- `README.md` — the full file index and cross-links to the sibling guides.
- `ai-features-in-this-codebase.md` — the concrete AI-feature ledger for this repo.

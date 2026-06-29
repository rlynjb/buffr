# Prompt Chaining

### *industry: prompt chaining · type: a decomposition pattern*

## Zoom out

Step back from a single window and look at buffr as a pipeline of steps. Some of those steps are model calls; some aren't. Chaining is about how the steps hand off.

**buffr as a sequence of steps, with the chaining seam marked**

```
┌──────────────────────────────────────────────────────────────┐
│  INDEX TIME (offline)   chunk ──► embed ──► store in pgvector  │
├──────────────────────────────────────────────────────────────┤
│  ★ THE SPLIT ★          index path  vs.  query path            │  ◄── this file
├──────────────────────────────────────────────────────────────┤
│  QUERY TIME (online)    embed ──► retrieve ──► answer          │
├──────────────────────────────────────────────────────────────┤
│  agent loop             tool-call turn ──► synthesis turn      │  ◄── this file too
└──────────────────────────────────────────────────────────────┘
```

You already build pipelines. A frontend request goes validate → fetch → transform → render, and each stage does one job and hands a clean output to the next. Prompt chaining is that discipline applied to AI steps: **each step has exactly one job, and its output is the next step's input.** We zoom here because buffr's two cleanest decompositions — the index/query split and the agent's two-turn shape — are exactly this pattern, and seeing them as chains is how you'll reason about adding real ones.

## Structure pass

The axis is **what each step is responsible for**, and the seam is where one job ends and the next begins.

**buffr's clearest chain: the index→query split**

```
  INDEX PATH (offline, once per doc)        QUERY PATH (online, per question)
  ┌────────────────────────────┐            ┌────────────────────────────┐
  │ job: make docs searchable  │            │ job: answer a question     │
  │  chunk ─► embed ─► store    │            │  embed ─► retrieve ─► answer│
  └────────────────────────────┘            └────────────────────────────┘
              │                                          ▲
              └──────────── hands off via ───────────────┘
                       the shared vector store
                  (agents.chunks in pgvector)
```

The seam is the vector store. The index path's *only* job is to leave the knowledge base in a searchable state; it doesn't answer anything. The query path's *only* job is to answer; it doesn't ingest. They never run in the same process, never share a window, and communicate solely through stored embeddings. That separation is what lets you re-index without touching the query code and tune retrieval without re-embedding. One job per step, clean handoff — that's the chain.

## How it works

### Move 1 — Mental model: a Unix pipe of single-job stages

Prompt chaining is `validate | fetch | transform` for AI steps. Each stage is small, testable, and replaceable because its contract is just "this input → that output."

**The chaining shape**

```
   step A            step B            step C
  ┌───────┐  out A  ┌───────┐  out B  ┌───────┐
  │ 1 job │ ──────► │ 1 job │ ──────► │ 1 job │
  └───────┘         └───────┘         └───────┘
   each step:  narrow prompt, narrow output, easy to eval in isolation
```

Frontend bridge: you'd never write one mega-function that validates, fetches, transforms, and renders in one tangle — you'd split it so each piece is testable and swappable. Chaining is the same refactor for prompts: a focused step beats one overloaded prompt trying to retrieve-and-reason-and-format in a single shot.

### Move 2 — Walk buffr's actual chains

**Part A — The index→query split (buffr's clearest chain)**

Two paths, two jobs, one shared store between them.

**The split, concretely**

```
  INDEX:  document ─► chunk(~512) ─► nomic-embed-text:v1.5 ─► agents.chunks
                                          (768-dim vectors)        │
                                                                   │ shared store
  QUERY:  question ─► nomic-embed-text:v1.5 ─► ANN search ─────────┘
                          (same embedder!)         │
                                                   ▼
                                            top-4 chunks ─► gemma2:9b answers
```

```ts
// src/session.ts:40-43 — the query-path stages wired in order
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });          // embed ─► retrieve
const tool     = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
```

The load-bearing detail: **both paths use the same embedder** (`nomic-embed-text:v1.5`, 768-dim). That's the contract that makes the handoff valid — query vectors and document vectors must live in the same space or cosine similarity is meaningless. The split is a chain whose shared type is "a 768-dim vector," enforced by `assertDim` in `src/pg-vector-store.ts:32`. Break the embedder agreement and the chain silently returns garbage neighbors.

**Part B — The tool-turn → synthesis-turn (the closest thing to an in-flight chain)**

Inside one query, the agent loop does run two-jobs-in-sequence: first turns gather evidence, the final turn is *forced* to answer with tools disabled.

**The two-phase agent loop**

```
  turn 0..n         tools ENABLED          ┌─ model may call search_knowledge_base
    │                                       └─ collect chunks into the window
    ▼
  forceFinal turn   tools DISABLED + synthesisInstruction appended to system
    │                                       └─ "You have NO more tool calls. Answer directly."
    ▼
  finalText
```

```ts
// aptkit run-agent-loop.ts:101-106 — the flip from gather to synthesize
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal  = turn === maxTurns - 1 || budgetSpent;
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ◄── tools removed on the final turn
  maxTokens, signal,
});
```

```ts
// aptkit RagQueryAgent.answer() — buffr's bounds + the synthesis job, src/session.ts:57 wires it
maxTurns: 6, maxToolCalls: 4,
synthesisInstruction: buildSynthesisInstruction(
  'Now answer the question directly and concisely, citing the sources you retrieved.',
),
```

This is a real two-job decomposition: **gather** (tool-calling allowed) then **synthesize** (tool-calling forbidden, answer mandatory). Removing the tools on the final turn is the chaining move — it strips the model's option to stall and forces the second job to actually produce output. `buildSynthesisInstruction` even appends "Do not say you need more queries" (`run-agent-loop.ts:73`). Without the flip, a weak model loops forever asking for more searches. The split *is* the forcing function.

### Move 2.5 — Current vs. future

**The honest truth: buffr is NOT a multi-LLM-call chain.** Both jobs above are real decompositions, but neither is the textbook chain of *several distinct LLM prompts feeding each other* (summarize → caption, or rewrite → retrieve → answer). buffr is single-purpose: one agent, one tool, one synthesis. Here's what a real chain would add.

**What a query-rewrite chain would look like (not built)**

```
  TODAY                              WITH A REWRITE CHAIN (not yet exercised)
  ──────────────────                 ───────────────────────────────────────
  question                           question
     │                                  │
     │ (embed raw)                   ┌──▼──────────────────┐
     ▼                               │ LLM call 1: REWRITE │  job: clean/expand
  retrieve                           │ "ship May" ─►       │  the query for recall
     │                               │ "what features did  │
     ▼                               │  I ship in May 2026"│
  answer                             └──┬──────────────────┘
                                        │ rewritten query
                                     ┌──▼──────────────────┐
                                     │ embed ─► retrieve   │  job: fetch evidence
                                     └──┬──────────────────┘
                                        │ chunks
                                     ┌──▼──────────────────┐
                                     │ LLM call 2: ANSWER  │  job: synthesize
                                     └─────────────────────┘
```

A query-rewrite chain inserts an LLM call *before* retrieval whose only job is to turn a terse or ambiguous question into a retrieval-friendly one — expand abbreviations, add context, split a compound question. buffr embeds the raw question today (`src/session.ts:42` pipeline), so a sloppy question gets sloppy neighbors. The rewrite step would slot in front of `createRetrievalPipeline`, and each step would be independently evaluable: did the rewrite improve recall? did synthesis ground its answer? That separability is the whole payoff of a real chain — and it's the not-yet-exercised work [C1.2] points at.

### Move 3 — The principle

**One job per step, and the handoff is the contract.** Chaining isn't about using more model calls — it's about refusing to overload one prompt. buffr already lives the discipline at two seams (index/query, gather/synthesize); both are honest chains even though only the agent loop runs in-flight. The growth path is the same move applied again: when one prompt is doing two jobs poorly (embedding a raw, messy question *and* hoping retrieval saves it), split it, and let each half be measured and fixed on its own.

## Primary diagram

The full picture: buffr's two real chains, plus where a third would slot in.

**buffr's chains, present and proposed**

```
  ┌─────────────────────────── INDEX CHAIN (offline) ──────────────────────────┐
  │  document ─► chunk(~512) ─► embed(nomic, 768d) ─► agents.chunks (pgvector)  │
  └──────────────────────────────────────┬─────────────────────────────────────┘
                                          │ shared vector store (the seam)
  ┌──────────────────────────────────────▼─────────────────────────────────────┐
  │  QUERY CHAIN (online)                                                        │
  │   question ─[would slot: REWRITE LLM call]─► embed ─► retrieve(top-4)        │
  │                                                            │                 │
  │   ┌──────────────── AGENT LOOP (in-flight two-job chain) ──▼──────────────┐  │
  │   │ turns 0..n: tools ENABLED ─► gather chunks                            │  │
  │   │ forceFinal turn: tools DISABLED + synthesisInstruction ─► ANSWER      │  │
  │   │ bounds: maxTurns 6 · maxToolCalls 4                                   │  │
  │   └───────────────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

After the box: today the rewrite slot is empty — buffr embeds the raw question. The index/query split and the gather/synthesize flip are the two chains that exist; the rewrite call is the cleanest next link to add.

## Elaborate

- **Why the split, not one process?** Indexing is expensive and rare; querying is cheap and constant. Chaining them through a store lets each scale and change independently — re-chunk strategy without touching the agent, swap the agent without re-embedding. Coupling them would force a re-index on every prompt tweak.
- **The synthesis turn is error-handling, not just structure.** Forcing the final answer (`forceFinal`, tools stripped, "do not say you need more queries") exists because weak local models stall. The chain's second job has a hard contract: produce text. That's why `answer()` falls back to `FALLBACK_ANSWER` if even that comes back empty — the chain guarantees an output.
- **A rewrite chain trades latency for recall.** Adding an LLM call before retrieval costs a round trip. On a local laptop that's not free. The honest framing: build it when retrieval-quality evals show raw questions are the bottleneck — not speculatively. Chain length is a cost, justified by a measured win.
- **Chaining vs. the agent loop is a real distinction.** A fixed chain is *you* deciding the steps in advance (rewrite → retrieve → answer). The agent loop lets the *model* decide how many tool turns to take. buffr leans on the loop; a rewrite chain would be a fixed, you-controlled step bolted in front. Different control, both valid — see `../04-agents-and-tool-use/`.

## Project exercises

### Add a query-rewrite chain step

- **Exercise ID:** [C1.2] (cite [C1.2], Phase 1) — Case B: buffr is single-purpose, NOT a multi-LLM-call chain. This is the primary target of the anchor.
- **What to build:** Insert one LLM call before retrieval whose only job is to rewrite the raw question into a retrieval-friendly query (expand abbreviations, add context), then feed the rewrite into the existing embed→retrieve path. Keep the step isolated and independently evaluable.
- **Why it earns its place:** buffr embeds the raw question today (`src/session.ts:42` pipeline); a sloppy question yields sloppy neighbors. This is the textbook chain link buffr is missing, and exactly what [C1.2] is about.
- **Files to touch:** `src/session.ts` (add the rewrite call between `loadConfig`/`createRetrievalPipeline` and the agent), reusing the `GemmaModelProvider`; persist both raw and rewritten queries via `src/supabase-trace-sink.ts`.
- **Done when:** A trace shows raw question vs. rewritten query per turn, and an A/B eval shows retrieval recall improves with the rewrite on a fixed question set.
- **Estimated effort:** 1–2 days.

### Eval each chain step in isolation

- **Exercise ID:** [C1.2b] (cite [C1.2], Phase 1) — companion that proves the chain's per-step contracts.
- **What to build:** Separate evals for the two existing jobs: a retrieval eval (does embed→retrieve surface the right chunks?) and a synthesis eval (does the forced final turn ground its answer in those chunks and cite them?).
- **Why it earns its place:** The payoff of chaining is per-step testability. buffr has end-to-end behavior but no per-seam eval, so a regression in one job hides inside the whole. This makes each chain link independently defensible.
- **Files to touch:** new evals under buffr's CLI/eval surface exercising `createRetrievalPipeline` (`src/session.ts:42`) and `RagQueryAgent.answer()` separately; results to `src/supabase-trace-sink.ts`.
- **Done when:** Retrieval and synthesis each have a standalone pass/fail eval, and you can attribute a quality drop to one specific step.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "Is buffr a prompt chain?"**

Not a multi-LLM-call chain. Its cleanest chain is the index→query split — two single-job paths handing off through the shared vector store. In-flight, the agent loop does a real gather→synthesize two-job split: tools enabled, then tools stripped on a forced final turn.

```
  index (chunk→embed→store) │ store │ query (embed→retrieve→answer)
  loop: gather (tools on) ─► synthesize (tools off, must answer)
```

Anchor: *"Two honest chains, no multi-prompt chain — yet."*

**Q: "What forces the agent to stop searching and answer?"**

The synthesis turn. On the final turn the loop removes the tool schemas and appends `synthesisInstruction` ("you have no more tool calls, answer directly"). Stripping tools is the forcing function — the model can't stall.

```
  forceFinal ─► tools: undefined + "answer now, don't ask for more queries"
```

Anchor: *"Take the tools away and the second job has to produce."*

**Q: "If you added one real chain link, what and where?"**

A query-rewrite LLM call before retrieval — its only job is turning a terse question into a retrieval-friendly one. It slots in front of the embed→retrieve pipeline. buffr embeds the raw question today, so this directly lifts recall, and each step stays independently evaluable.

```
  question ─► [REWRITE] ─► embed ─► retrieve ─► answer
```

Anchor: *"Rewrite-before-retrieve is the cleanest missing link."*

## See also

- `./01-context-window.md` — each chain step is its own window; splitting keeps any one window short.
- `./02-lost-in-the-middle.md` — a rewrite step that improves retrieval also shrinks the set the model must read.
- `../03-retrieval-and-rag/` — the index/query split is the retrieval pipeline; same embedder both sides is the contract.
- `../04-agents-and-tool-use/` — the loop (`runAgentLoop`, `maxTurns:6`) is model-controlled steps vs. a fixed you-controlled chain.

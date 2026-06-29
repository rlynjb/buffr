# System design template — multi-agent research assistant

Same code, interview framing. This reframes buffr as the answer to
"design an agentic research system." The architecture/data/scale/eval/
failure bullets are generic; the last two are answered about buffr only.

- **The prompt:** "Design a system that answers a complex research
  question by gathering from multiple sources and synthesizing."

- **Standard architecture:** a supervisor decomposes the question →
  parallel worker agents each retrieve from a source (agentic RAG per
  worker) → the supervisor synthesizes with citations.

  ```
  question → supervisor (decompose)
       ┌──────────┬──────────┐
       ▼          ▼          ▼
   worker A    worker B    worker C   ← each: agentic RAG over one source
   (concurrent, bounded by a semaphore)
       └──────────┼──────────┘
                  ▼
        supervisor synthesizes → cited answer
  ```

- **Data model:** a source registry, per-worker retrieval indices, a
  shared findings store keyed by sub-question, and citation provenance
  per claim.

- **Key components:** decomposition (supervisor), parallel retrieval
  (workers, fan-out), synthesis (merge agent), citation tracking.
  Decisions per component: tools-style vs handoff-style delegation;
  shared state vs message passing.

- **Scale concerns:** at many sources, fan-out cost; at deep questions,
  iteration blowup (cap it); at high volume, the supervisor becomes the
  bottleneck (cheap workers, expensive supervisor only).

- **Eval framing:** trajectory eval (did each worker hit the right
  source?), answer groundedness (every claim cites a retrieved chunk),
  cost/latency per question.

- **Common failure modes:** synthesis of contradictory sources, citation
  hallucination, cost blowup from deep loops, lost-in-the-middle across
  many worker results.

- **Applies to this codebase:** **partially.** buffr already has the
  *worker* — `RagQueryAgent` is exactly one agentic-RAG retriever
  (`rag-query-agent.js`), with citation snippets built into its tool
  results (`search-knowledge-base-tool.js:54-63`). It has the
  single-source retrieval and grounded-answer half. What it lacks is the
  multi-agent half: there's no supervisor, no decomposition, no parallel
  workers, no synthesis-across-sources. buffr is N=1 of this template's
  N workers. It also has one source (the `chunks` store), so "parallel
  retrieval from multiple sources" doesn't apply yet.

- **How to make it apply:** three concrete refactors in buffr's files.
  (1) Add a decomposition step before `agent.answer` in
  `src/session.ts` that splits a question into sub-questions. (2) Run the
  existing `RagQueryAgent` (or just its `search_knowledge_base` tool) once
  per sub-question, concurrently, with a `Promise.all` semaphore — buffr
  already has the unbounded `Promise.all` shape in
  `src/supabase-trace-sink.ts:92` to bound. (3) Add a synthesis pass that
  merges the per-sub-question findings with citations (buffr's tool
  already returns `[docId] snippet` citations). The supervisor would be a
  second `RagQueryAgent`-style call with the merge instruction. Gating
  item: this only earns its overhead once buffr has *multiple sources* to
  retrieve from in parallel — until then it's one worker doing one
  retrieval, and a supervisor adds the 2-5x coordination tax for no gain
  (see `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`).

## See also

- `03-multi-agent-orchestration/02-supervisor-worker.md` ·
  `04-parallel-fan-out.md` — the topology this template uses
- `02-agentic-retrieval/01-agentic-rag.md` — the worker's retrieval loop
- `agent-patterns-in-this-codebase.md` — buffr's actual patterns

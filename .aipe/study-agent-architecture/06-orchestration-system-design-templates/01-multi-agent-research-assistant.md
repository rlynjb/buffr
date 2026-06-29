# 01 — Multi-Agent Research Assistant

**Prompt:** *"Design a system that answers a complex research question by gathering from
multiple sources and synthesizing them."*

The canonical answer is a **supervisor / fan-out / merge** topology: one planner splits the
question into sub-questions, parallel workers each do their own retrieval, and the
supervisor stitches the partial answers into one cited report.

```
  STANDARD ARCHITECTURE — supervisor fan-out + synthesis
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  user question: "complex, multi-part research query"                       │
  └───────────────────────────────────┬────────────────────────────────────────┘
                                       ▼
                            ┌─────────────────────┐
                            │   SUPERVISOR         │  decompose into N sub-questions
                            │   (planner)          │  assign a source/scope per worker
                            └─────────┬───────────-┘
                 ┌────────────────────┼────────────────────┐   (fan-out, parallel)
                 ▼                    ▼                    ▼
          ┌────────────┐      ┌────────────┐       ┌────────────┐
          │  WORKER 1  │      │  WORKER 2  │       │  WORKER 3  │   each = agentic RAG
          │ agentic RAG│      │ agentic RAG│       │ agentic RAG│   loop over ITS source
          │  source A  │      │  source B  │       │  source C  │
          └─────┬──────┘      └─────┬──────┘       └─────┬──────┘
                │ partial+cites      │ partial+cites      │ partial+cites
                └────────────────────┼────────────────────┘   (fan-in / merge)
                                     ▼
                            ┌─────────────────────┐
                            │   SUPERVISOR         │  dedup, resolve conflicts,
                            │   (synthesizer)      │  synthesize, attach citations
                            └─────────┬───────────-┘
                                      ▼
                         final cited answer (one report)
```

Each worker is itself a small ReAct retrieval loop — which is exactly what buffr is. The
multi-agent part is everything *wrapping* the worker: the planner above and the merge below.

## Standard architecture

Three roles, two boundaries:

- **Supervisor (decompose):** turns one fuzzy question into N scoped sub-questions, decides
  which source/worker handles each, sets a per-worker budget.
- **Workers (retrieve):** N parallel agentic-RAG loops. Each owns one source (a corpus, an
  API, a vector index), runs its own search→read→answer loop, returns a *partial answer with
  citations*. They don't talk to each other.
- **Supervisor (synthesize):** fans in the partials, dedups overlapping claims, resolves
  contradictions (recency / source-authority rules), and emits one answer with provenance.

The fan-out is the whole point: independent sub-questions run concurrently, so wall-clock is
the slowest worker, not the sum.

## Data model

- **Task registry / plan:** the decomposition — sub-question → assigned worker → source →
  budget. Often a typed plan object or a small graph (LangGraph-style state).
- **Per-worker retrieval index:** one vector store / search index per source. Workers must
  NOT share a single undifferentiated index or you've lost the routing.
- **Provenance store:** every claim in the final answer carries `(source_id, chunk_id,
  score)` so the synthesizer's citations are real, not hallucinated.
- **Trace / trajectory:** which worker ran, what it retrieved, what it returned — needed for
  both debugging and trajectory eval.

## Key components

- **Decomposer:** prompt-driven or learned. Decision: fixed N vs. adaptive N (let the planner
  decide how many sub-questions). Adaptive is better but harder to eval.
- **Worker scheduler:** parallel with a concurrency cap. Decision: kill-slow-worker timeout
  vs. wait-for-all. Research assistants usually use a deadline + "answer with what came back."
- **Per-worker control envelope:** each worker needs its own turn/tool budget so one runaway
  worker can't stall the merge.
- **Synthesizer:** the hard component. Decision: map-reduce (summarize each partial, then
  combine) vs. refine (fold partials into a running answer). Map-reduce parallelizes; refine
  keeps better global coherence.
- **Citation merger:** dedup by `(source, chunk)`, keep highest-scoring instance.

## Scale concerns

- **Fan-out width:** N workers = N× the token + retrieval cost per query. Cost scales with
  decomposition granularity, not user count — a 12-way split is 12× a single query.
- **Synthesis context window:** N partial answers must fit in the synthesizer's window.
  Beyond ~8–10 workers you need hierarchical merge (merge in pairs/tiers).
- **Tail latency:** the slowest worker sets wall-clock. One source with a cold index drags
  the whole query.
- **Source heterogeneity:** different sources, different freshness, different trust — the
  conflict-resolution rules get gnarly as sources multiply.

## Eval framing

- **End-to-end answer quality:** faithfulness (every claim cite-backed), completeness (did it
  cover the sub-questions), correctness (human or LLM-judge over a gold set).
- **Retrieval per worker:** precision@k / recall@k on each source independently — a bad
  worker is invisible in the final answer until you eval it in isolation.
- **Decomposition quality:** did the planner split the question well? Eval the plan, not just
  the answer.
- **Trajectory eval:** did the right worker fire for the right sub-question? Needs the full
  trace, not just the final text.

## Common failure modes

- **Over-decomposition:** planner shatters a simple question into 10 sub-questions, 10× cost
  for no gain.
- **Worker overlap:** two workers retrieve the same chunks; synthesizer double-counts.
- **Citation drift:** synthesizer writes a fluent answer but attaches the wrong source — the
  classic "looks cited, isn't."
- **Silent worker failure:** a worker errors or returns empty, merge proceeds, answer is
  quietly incomplete.
- **Synthesis context overflow:** too many partials, synthesizer truncates and drops sources.

## Applies to this codebase: **PARTIALLY**

buffr is exactly **one worker's worth** of this topology — the leaf — and nothing above it.

What buffr HAS (one worker):

- An agentic-RAG retrieval loop: `RagQueryAgent.answer()` at
  `/Users/rein/Public/aptkit/packages/agents/rag-query/src/rag-query-agent.ts:62-83`. Search
  first, ground, synthesize — that's a worker.
- Citations, for real: `toResult()` builds `[docId] snippet` citations at
  `/Users/rein/Public/aptkit/packages/retrieval/src/search-knowledge-base-tool.ts:108-118`.
  The worker's "partial answer with citations" already exists.
- A per-worker control envelope: `maxTurns:6 / maxToolCalls:4` + forced synthesis
  (`rag-query-agent.ts:75-79`). This is precisely the per-worker budget the template wants.

What buffr LACKS (everything multi-agent):

- **No supervisor / decomposer.** One question goes straight to one loop. No plan object, no
  sub-questions.
- **No fan-out.** No parallel workers, no scheduler.
- **One source.** A single `PgVectorStore`, wired at
  `/Users/rein/Public/buffr/src/session.ts:41-44`. The whole "gather from *multiple* sources"
  premise is absent.
- **No merge step.** Nothing to synthesize across — there's only one partial.

So: buffr answers the prompt the way a single retrieval worker does. The interview answer is
"I've built the leaf; the multi-agent layer is the wrapper I'd add."

## How to make it apply

Three additions, leaving the existing worker untouched:

1. **Add a decomposition supervisor.** A new planner agent (its own capability + tool policy)
   that takes the question and emits N `{subQuestion, source}` tasks. This is a new file in
   `aptkit/packages/agents/` consumed by buffr, mirroring `rag-query-agent.ts`.
2. **Add parallel workers + a scheduler.** Wrap `RagQueryAgent` so buffr can instantiate one
   per source and `Promise.all` them with a concurrency cap and per-worker deadline. The
   worker code at `rag-query-agent.ts:62-83` becomes the fan-out unit unchanged.
3. **Add a merge step.** A synthesizer that fans in the partials and their citations and
   produces one cited answer — dedup by `(docId, chunkId)` reusing the citation shape from
   `search-knowledge-base-tool.ts:108-118`.

And to make "multiple sources" real, the single `PgVectorStore` wire at `session.ts:41-44`
becomes one store *per source*, each handed to a different worker.

Honest framing: today buffr **is** the leaf worker. The refactor is additive — you're not
rebuilding the worker, you're building the supervisor and merge around it. That's the
cheapest of the three templates to reach because the hard part (a grounded, cited retrieval
loop) already ships.

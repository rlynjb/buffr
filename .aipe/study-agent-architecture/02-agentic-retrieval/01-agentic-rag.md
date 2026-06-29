# Agentic RAG — retrieval as a loop the agent drives

**Industry name(s):** agentic RAG · iterative retrieval · ReAct-over-
retrieval. **Type label:** Industry standard.

**In this codebase: yes — this is what buffr's loop *is*.** buffr's
single tool is `search_knowledge_base`, and the ReAct loop lets the
model retrieve, observe, and retrieve again (capped at 4 calls). That
makes buffr's agent *agentic RAG by construction* — though in practice
most questions resolve in one search.

## Zoom out, then zoom in

Agentic RAG is the shift from retrieval as a one-shot pipeline step to
retrieval as a control loop the agent drives. This file covers that
shift; the retrieval *mechanics* (embeddings, chunking, cosine search)
are system-design concerns covered elsewhere.

```
  Zoom out — where retrieval sits as the loop's one tool

  ┌─ Agent layer ───────────────────────────────────────────┐
  │  ReAct loop — model decides: search again, or answer     │ ← we are here
  │     │ the ONE action available                           │
  │     ▼                                                    │
  │  ★ search_knowledge_base ★  (the agent's retrieval loop)  │
  └───────────────────────────┬──────────────────────────────┘
                              │  query → ranked chunks
  ┌─ Retrieval + storage ─────▼──────────────────────────────┐
  │  pipeline.query → PgVectorStore.search (cosine, HNSW)     │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: static RAG retrieves once and generates — no second try.
Agentic RAG puts retrieval inside the loop so the model can evaluate
what came back and search again with a refined query. buffr is the
agentic kind; whether it loops or not on a given question is the
model's call.

## Structure pass

**Layers.** Two: the agent loop (decides whether to retrieve again) and
the retrieval pipeline (does one retrieval). Static RAG has only the
second; agentic RAG adds the first.

**Axis — "how many retrievals per answer, and who decides?"** Static
RAG: exactly one, the engineer. Agentic RAG: variable, the model.
buffr is the variable case — 0 to 4 retrievals per question, model-
decided.

**Seam.** The seam is the tool-call boundary: the model emits a query
as intent, the harness runs the pipeline. The agentic part is that the
model can read the result and emit *another* query — a loop the seam
allows.

## How it works

#### Move 1 — the mental model

You know the difference between one `fetch` and a `fetch` inside a
`while` that keeps requesting until it has enough data? Static RAG is
the single fetch; agentic RAG is the loop. Same retrieval call, but
the agent decides whether one was enough.

```
  Pattern — static RAG vs the agentic loop

  Static RAG (one shot):
    query → retrieve top-k → stuff → generate
    (no evaluation, no second try)

  Agentic RAG (a loop — buffr):
    ┌──────────────────────────────────────────┐
    │  model: do I need to search? what for?    │
    └───────────────────┬───────────────────────┘
                        ▼
    ┌──────────────────────────────────────────┐
    │  search_knowledge_base(query) → chunks     │
    └───────────────────┬───────────────────────┘
                        ▼
    ┌──────────────────────────────────────────┐
    │  model: enough to answer?                  │
    └────────┬──────────────────────┬────────────┘
             ▼ no                   ▼ yes
        search again            generate answer
        (refine query)
             │
             └──── loop (capped at 4 calls)
```

#### Move 2 — the walkthrough

**The loop's one tool is retrieval.** buffr grants exactly one tool
(`ragQueryToolPolicy`, `rag-query-agent.js:8-11`), and that tool is the
retrieval pipeline wrapped as `search_knowledge_base`
(`src/session.ts:42-44`):

```ts
const pipeline = createRetrievalPipeline({ embedder, store });
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
```

So the only thing the model can *do* is retrieve. That's why buffr's
ReAct loop and "agentic RAG" are the same object seen from two sides —
the action space is retrieval.

**The agent can refine and re-retrieve.** The loop allows up to 4 tool
calls (`rag-query-agent.js:48`). If the model's first query returns
weak chunks, it can emit a second, refined query — the observation
(the chunks) is fed back as a `tool_result` message
(`run-agent-loop.js:97-104`) so the next Thought sees what came back.
That feedback is the difference from static RAG: the model reasons over
the retrieval result and can act on it.

**`minTopK: 4` is a floor against a weak model under-fetching.** The
tool forces at least 4 results even if the model asks for fewer
(`search-knowledge-base-tool.js:5,32`):

```js
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const topK = Math.max(requestedTopK, minTopK);
```

That's a small but real piece of hardening: Gemma might emit `top_k:
1` and starve itself; the floor guarantees enough context to ground an
answer.

**The honest reality: it usually doesn't loop.** Most buffr questions
are single retrievals — the model searches once and answers. The
agentic *capability* is there (the cap is 4, the feedback is wired),
but the *behavior* is usually one-shot. That's fine: agentic RAG is
worth it only when one-shot retrieval measurably fails, and for
personal-knowledge questions it usually doesn't.

```
  Layers-and-hops — one agentic retrieval cycle

  ┌─ Model ─────┐ hop 1: search(query)  ┌─ Harness + pipeline ──────┐
  │ Thought:    │ ───────────────────►  │ createSearchKnowledgeBase │
  │ "search X"  │                       │ → pipeline.query          │
  │             │ ◄───────────────────  │ → PgVectorStore.search    │
  │ Obs: chunks │ hop 2: ranked chunks  │   (cosine, HNSW, 768-dim) │
  │ "enough?"   │                       └───────────────────────────┘
  └─────────────┘  loop if not, capped at 4
```

#### Move 3 — the principle

All agentic RAG is agentic AI; not all agentic AI does retrieval.
buffr's agent *is* agentic RAG because its single action is search. The
tradeoff agentic RAG takes on — roughly 3-10x token cost and 2-5x
latency over static RAG when it actually loops — means the
above-threshold rule applies hard: let the loop run only when one-shot
retrieval measurably fails. buffr keeps the loop available but cheap by
capping it at 4 and resolving most questions in one pass.

## Primary diagram

```
  buffr's agentic RAG (the loop = the retrieval driver)

  question
     │
     ▼
  ┌─ ReAct loop (capped 4 search calls) ─────────────────────┐
  │  search_knowledge_base(q1) → chunks                       │
  │     │ model: enough?                                      │
  │     ├ no → search_knowledge_base(q2 refined) → chunks     │
  │     └ yes ─────────────────────────────────┐             │
  │  forced synthesis on last turn ─────────────┴─► grounded  │
  │                                                 answer    │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Agentic RAG is the name for what you get when you make retrieval a tool
in a ReAct loop rather than a fixed pipeline stage — see `03-react.md`
for the same loop from the reasoning side. The retrieval mechanics
underneath (embedding with nomic-embed-text, cosine search over
pgvector, HNSW) are walked in
`.aipe/study-system-design/01-vector-store-adapter.md`. The next
refinement — grading whether retrieved chunks are actually relevant
before generating — is self-corrective RAG (`02-self-corrective-rag.md`),
which buffr does not do.

## Interview defense

**Q: Is buffr's RAG static or agentic?**
Agentic — retrieval is the agent's one tool inside a ReAct loop, so the
model can search, read the chunks, and search again with a refined
query, capped at 4 calls (`rag-query-agent.js:48`). In practice most
questions resolve in one search, but the loop is there for the ones
that don't. Static RAG would retrieve exactly once with no second try.

```
  static: query → retrieve → generate
  agentic: loop[ search → observe → search? ] → generate
```

**Anchor:** "buffr's ReAct loop and its agentic RAG are the same object
— the single action is retrieval."

**Q: What stops the retrieval loop from running away?**
The same budget exit as any agent loop: `maxToolCalls: 4` plus the
forced synthesis turn that strips the tool and demands an answer
(`run-agent-loop.js:28-34`). Without it, a weak model could keep
re-querying forever.

## See also

- `02-self-corrective-rag.md` — grading relevance before generating
- `03-retrieval-routing.md` — routing across multiple sources
- `03-react.md` — the same loop from the reasoning side
- `04-agent-infrastructure/02-agent-memory-tiers.md` — memory recalled
  through this *same* search tool
- `.aipe/study-system-design/01-vector-store-adapter.md` — the
  retrieval mechanics underneath

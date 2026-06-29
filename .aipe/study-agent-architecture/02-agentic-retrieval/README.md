# B — Agentic Retrieval

*Sub-section index — Industry standard + Project-specific.*

This section is about ONE shift: retrieval stops being a pipeline step you run *before*
the model, and becomes a tool the model *drives* inside its loop. In your AdvntrCue app,
retrieval was a `.then()` in a chain — embed the question, pull top-k from pgvector, stuff
the chunks into the prompt, generate, done. buffr inverts that. The model decides whether
to search, what to search for, and whether to search *again* — up to a budget — before it
answers.

## Where this section sits

The agent loop (Section A) is the engine. Retrieval is the one tool plugged into it. This
section zooms into that tool-as-control-loop seam.

```
  buffr's stack — Section B is the retrieval tool inside the loop

  ┌─ Session (persist → answer → remember) ────────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Agent layer (Section A: the ReAct loop) ──▼───────────────┐
  │   runAgentLoop: step → execute → accumulate → terminate    │
  │   ┌─ ★ SECTION B: retrieval AS the loop's tool ★ ────────┐ │
  │   │  search_knowledge_base  (the ONE tool the model has) │ │
  │   │   01 agentic RAG     model calls search 0..4 times   │ │  [IMPLEMENTED]
  │   │   02 self-corrective grade chunks, retry on miss     │ │  [NOT YET]
  │   │   03 routing         pick vector vs SQL vs web        │ │  [NOT YET]
  │   └──────────────────────────────────────────────────────┘ │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage (pgvector, HNSW cosine) ──────────▼───────────────┐
  └────────────────────────────────────────────────────────────┘
```

buffr runs exactly one of these three: **agentic RAG** (file 01). Files 02 and 03 are the
escalations buffr deliberately does not run yet — here so you can name them and defend the
omission.

## Reading order

```
  01-agentic-rag.md          ← THE pattern buffr runs: ReAct whose primary tool   [IMPLEMENTED]
        │                       is retrieval; model searches 0..4×, then synthesis
        ▼
  02-self-corrective-rag.md  ← grade chunks before trusting them; retry on miss   [NOT YET]
        │                       (the principle: retrieval success != answer success)
        ▼
  03-retrieval-routing.md    ← pick the right SOURCE per query                    [NOT YET]
                                (buffr has one source: pgvector)
```

Read 01 first and carefully — it is the only implemented pattern, and it is the spine of
buffr. Read 02 and 03 to know what the next two rungs cost and when they earn their keep.

## The one-line anchor for this section

buffr's retrieval shape is **single-agent agentic RAG** (primary anchor): a ReAct loop
whose primary — and only — tool is `search_knowledge_base`, called 0 to 4 times across up
to 6 turns, then forced to synthesize. No relevance grader. No query-rewrite fallback. No
multi-source router. The simplest honest form of agentic retrieval.

## The reframe to carry into an interview

> All agentic RAG is agentic AI; not all agentic AI does retrieval.

Agentic RAG is the special case where the agent's tools happen to be search tools. buffr is
that special case taken to its minimum: exactly one search tool. That is not a weakness to
apologize for — it is the correct scope for a personal knowledge assistant over one store.

## File map

- `01-agentic-rag.md` — *Implemented.* The verdict file. Static RAG vs the agentic loop,
  the whether/what/again decision the model makes, the 3-10× token / 2-5× latency cost
  buffr accepts, and exactly why buffr is the *simplest* agentic-RAG (no decomposition, no
  grader-driven re-retrieval).
- `02-self-corrective-rag.md` — *Not yet implemented.* The grade-and-retry pattern. The
  lightweight stand-ins buffr ships instead (the `minTopK:4` floor, the "say so plainly"
  prompt), and what a real grader would add.
- `03-retrieval-routing.md` — *Not yet implemented.* Routing a query to the right source.
  buffr has one source; memory rows and document rows share it with no router between them.
  Points to Section F for the multi-source refactor.

## Cross-links to sibling guides

This section covers the agentic-retrieval *control loop*, not the retrieval mechanics
underneath it. For those:

- **`study-ai-engineering`** — embeddings, chunking, vector DBs, HNSW, hybrid search, RRF,
  reranking, classic RAG and GraphRAG. The mechanics this section assumes you already know.
- **`study-agent-architecture/01-reasoning-patterns/`** — the ReAct loop that drives the
  search tool (`02-agent-loop-skeleton.md`, `03-react.md`). This section is that loop with
  retrieval as its payload.
- **`study-agent-architecture/04-agent-infrastructure/`** — the shared store where memory
  rows and document rows live together (the routing nuance in file 03).

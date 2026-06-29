# SECTION B — Agentic retrieval

Anchor: single-agent (primary). Cross-references the retrieval
*mechanics* (embeddings, chunking, cosine search, HNSW) to
`.aipe/study-system-design/01-vector-store-adapter.md` — this section
covers retrieval as a *control loop*, not the vector mechanics.

buffr's single tool is retrieval, so its ReAct loop and its agentic RAG
are the same object. This section is exercised.

## Reading order

1. `01-agentic-rag.md` — the loop's one tool; this IS buffr's agent.
   **Exercised** (usually one-shot in practice).
2. `02-self-corrective-rag.md` — grading chunks before generating.
   *Not yet implemented — the highest-value retrieval upgrade.*
3. `03-retrieval-routing.md` — routing across sources. *Not applicable —
   one source; the one-store-two-kinds design is deliberate.*

Note the recurring honest thread: buffr shares one `chunks` store for
documents and memory, recalled through one search tool — which makes the
relevance grader (`02-`) more valuable and a router (`03-`) unnecessary.

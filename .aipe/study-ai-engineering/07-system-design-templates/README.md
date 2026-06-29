# Study — System Design Templates (AI side)

These are **interview reframes of buffr**, not new code. The same `RetrievalPipeline` + `PgVectorStore` + `RagQueryAgent` you already built gets pointed at the two canonical AI system-design prompts an interviewer will actually open with. Nothing here asks you to ship something; it asks you to *defend what you shipped* against the question's frame, and to name — precisely — the gap between buffr and the textbook answer.

The point is leverage. You will not get asked "explain your RAG pipeline." You will get asked "design a search ranking system" or "design a tech-support chatbot," and you have to recognize, in real time, which parts of buffr already answer that and which parts are honestly missing. These files do that recognition for you ahead of time so you walk in with the mapping pre-loaded.

## The fixed 9-bullet shape

Every template file in this directory uses the **same nine labelled bullets** — this is a different shape from the per-concept study files (no Zoom out / How it works / diagrams-lead). The shape is:

1. **The prompt** — the verbatim interview prompt, one sentence.
2. **Standard architecture** — the box-and-arrow reference design, ASCII, top-to-bottom.
3. **Data model** — what's stored where, one bullet per structure.
4. **Key components** — named sub-systems, each with one technical choice and its rationale.
5. **Scale concerns** — ordered by which breaks first, each with a concrete threshold.
6. **Eval framing** — the metrics that matter, online vs offline.
7. **Common failure modes** — what the interviewer probes, each with its mitigation.
8. **Applies to this codebase** — `yes` / `partially` / `no`, answered about buffr's *real* code.
9. **How to make it apply** — the concrete refactor in buffr's real files to close the gap.

The honest answer in bullet 8 is almost always **partially**. That is the right answer and the strong one. A candidate who claims "yes, buffr is a production search ranking system" is lying and an interviewer will catch it in two follow-ups. A candidate who says "buffr is the candidate-retrieval layer of a search system; here is exactly what's missing and what I'd build next" is the one who gets the offer.

## The two templates

- **`01-search-ranking.md`** — *"Design a search ranking system that takes a query and returns top-k relevant items."* buffr's embed→cosine pipeline **is** the candidate-retrieval stage. What's missing: a learned ranker, click logging, search-style queries. Verdict: **partially**.
- **`02-tech-support-chatbot.md`** — *"Design a tech-support chatbot that answers, escalates when it can't, and learns from corrections."* buffr's RAG-over-KB + grounding prompt maps to the answer path only. What's missing: intent classification, escalation, a correction loop — and the *intent* is personal Q&A, not support. Verdict: **partially / no**.

## Phase 5 anchor

These two files are the AI-side deliverables for **Phase 5** of the study plan:

- **C5.10** — search ranking system design → `01-search-ranking.md`.
- **C5.14** — tech-support chatbot system design → `02-tech-support-chatbot.md`.

The "how to make it apply" refactors reuse existing Phase 2 exercises where the gap is the same one already named elsewhere — e.g. the learned-reranker work in `01-search-ranking.md` is the same `[B2B.6]` reranking exercise from `../03-retrieval-and-rag/07-reranking.md`.

## Cross-links

- **`../03-retrieval-and-rag/`** — the real machinery these reframes wrap. `04-vector-databases.md` (pgvector + HNSW), `05-dense-vs-sparse.md` and `06-hybrid-retrieval-rrf.md` (why buffr's pure-dense retrieval is a known gap in the ranking frame), `07-reranking.md` (the learned-ranker stage `01` asks for), `08-query-rewriting-hyde.md` (the search-vs-paraphrase query gap).
- **`../05-evals-and-observability/`** — how you'd *measure* either system. `01-eval-set-types.md` (the golden set `01`'s ranking eval extends), `04-llm-observability.md` (the `SupabaseTraceSink` trajectory capture both reframes lean on).
- **`../01-llm-foundations/`** — `02`'s intent-router gate ties to the heuristic-before-LLM file (route cheaply before you spend a model pass).

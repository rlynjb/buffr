# Study — ML System Design Templates (model side)

These are **interview reframes of buffr**, not new code. They sit one floor down from `07-system-design-templates/`: where `07` reframes buffr against *AI-system* prompts (search ranking, support chatbot — things buffr largely *is*), this directory reframes buffr against *classical-ML* prompts (recommender, anomaly detector, object detector — things buffr largely *is not*). That asymmetry is the whole point. buffr is an LLM RAG application that **trains no model** — it consumes pre-trained ones (Ollama `gemma2:9b` for generation, `nomic-embed-text:v1.5` for 768-dim embeddings) and stores their output in Postgres + pgvector. So when an interviewer opens with "design a recommender," the honest answer is rarely "yes, that's buffr." It's "no learned model here, but here is the real ranking/anomaly surface buffr *does* have, and here is exactly what I'd add to turn it into the thing you asked for."

These files do that recognition ahead of time so you walk in with the mapping — and the honest gap — pre-loaded.

## Why these lean Case B / honest-reframe

buffr trains nothing. There is no dataset, no label set, no training loop, no model artifact to version. Every classical-ML prompt that assumes "you have a trained model serving predictions" therefore hits buffr at an angle. The strong interview move is **not** to force buffr into the frame — an interviewer catches a forced mapping in two follow-ups. The strong move is **Case B**: name the canonical architecture cleanly, point at the one real buffr surface that rhymes with it (retrieval ranking, low-score signal), and state precisely what's missing. A candidate who says "buffr has no learned recommender, but its cosine retrieval *is* a content-based ranking surface, and here is the collaborative-filtering layer it can't have because there's one user" gets the offer. The candidate who claims buffr is a production recommender does not.

## The fixed 9-bullet shape

Every template file here uses the **same nine labelled bullets** — the same shape as `07-system-design-templates/`, a *different* shape from the per-concept study files in `08-machine-learning/` (no Zoom out / How it works lead):

1. **The prompt** — the verbatim interview prompt, one sentence.
2. **Standard architecture** — the box-and-arrow reference design, ASCII, top-to-bottom.
3. **Data model** — what's stored where, one bullet per structure.
4. **Key components** — named sub-systems, each with one technical choice and its rationale.
5. **Scale concerns** — ordered by which breaks first, each with a concrete threshold.
6. **Eval framing** — the metrics that matter, online vs offline.
7. **Common failure modes** — what the interviewer probes, each with its mitigation.
8. **Applies to this codebase** — `yes` / `partially` / `no`, answered about buffr's *real* code.
9. **How to make it apply** — the concrete refactor in buffr's real files to close the gap.

## The three templates

- **`01-recommender-system.md`** — *"Design a recommender that surfaces N items per user from M items maximizing engagement."* buffr has **no learned recommender**. Its cosine retrieval (`PgVectorStore.search`, `order by embedding <=> $1`) is a real **content-based ranking** surface, but with one user there is no collaborative signal at all. Verdict: **no** (as a learned recommender) — but the retrieval ranking is the content-based seed.
- **`02-anomaly-detection.md`** — *"Design an anomaly detection system that flags unusual events in a stream."* buffr has no anomaly detector, but the **low-all-retrieval-scores → fallback-answer** path is a hand-built anomaly signal (the KB has nothing relevant). The LLM analog is hallucination / groundedness detection. Verdict: **partially**.
- **`03-object-detection-cv.md`** — *"Design a real-time on-device CV object detector."* buffr is **text-only** — no vision, no frames, no pixels. The file walks the canonical CV architecture honestly without forcing a buffr mapping. Verdict: **no**.

## Phase 5 anchor

These three files are the model-side deliverables for **Phase 5** of the study plan:

- **C5.11** — recommender system design → `01-recommender-system.md`.
- **C5.12** — anomaly detection system design → `02-anomaly-detection.md`.
- **C5.13** — object detection / CV system design → `03-object-detection-cv.md`.

The "how to make it apply" refactors reuse Phase 2/3 exercises where the gap is one already named elsewhere — e.g. the groundedness flagger in `02` is the same unwired-`RubricJudge` work `[B3.9]` from `../05-evals-and-observability/03-llm-as-judge-bias.md`.

## Cross-links

- **`../08-machine-learning/`** — the per-concept ML theory these reframes apply. `10-recommender-systems.md` (content vs collaborative vs hybrid — the spine of `01`), `11-cold-start.md` (why a one-user system is permanent cold-start), `15-drift-detection.md` (PSI / covariate shift — the seed of `02`'s drift monitor), `12-on-device-inference.md` (the on-device constraint `03` and buffr's local-Ollama stance share).
- **`../07-system-design-templates/`** — the AI-side reframes (search ranking, support chatbot) that buffr largely *is*, as the counterweight to these three that it largely *is not*.
- **`../05-evals-and-observability/`** — `03-llm-as-judge-bias.md` (the unwired `RubricJudge` that `02`'s groundedness flagger wires), `04-llm-observability.md` (`SupabaseTraceSink`, the event stream `02`'s drift monitor would read).

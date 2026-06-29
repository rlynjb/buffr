# 07 — System design templates

These are not buffr features. They are interview prompts — the canonical "design a search ranking system / a tech support chatbot" whiteboard questions — reframed against buffr so the reader can defend the architecture *and* state honestly where buffr lands on it.

Each file is one IK-module-style template with a **fixed 9-bullet shape**, not the per-concept teaching format used elsewhere in this guide. There is no Zoom-out / How-it-works / Project-exercises. The nine bullets are:

- **The prompt** — verbatim interview prompt, one sentence.
- **Standard architecture** — the box-and-arrow diagram you draw in the first 60 seconds.
- **Data model** — what's stored where, one bullet per structure.
- **Key components** — named sub-systems, each one sentence + one technical choice with rationale.
- **Scale concerns** — ordered by what hits first, each with a concrete threshold.
- **Eval framing** — offline vs online metrics (precision@k, recall@k, MRR, NDCG).
- **Common failure modes** — name the failure, then the mitigation.
- **Applies to this codebase** — yes / partially / no, answered honestly for buffr.
- **How to make it apply** — the concrete refactor naming real buffr files.

## The templates

- **`01-search-ranking.md`** — Applies to buffr: **partially.** buffr's embed→ANN→cosine top-k *is* the candidate-retrieval layer, but there is no learned ranker, no click logging, no query understanding, and the eval is precision@1/recall@3 over three rows.
- **`02-tech-support-chatbot.md`** — Applies to buffr: **partially.** The RAG-over-corpus + bounded agent loop is structurally a chatbot's RAG core, but buffr is a single-user tool with no intent classification, no escalation, and no feedback loop — though the `agents.messages` trajectory trace is exactly the substrate a feedback loop needs.

The honest answer for both is *partially*: buffr owns the retrieval spine of each system and is missing the learned-ranking / human-in-the-loop layers that make them production systems.

# 09 — ML system design templates

These are classical-ML interview prompts — recommender, anomaly detection, object detection — reframed against buffr. The honest framing up front: **buffr trains no ML model.** It uses two pre-trained models off the shelf (`gemma2:9b` for generation, `nomic-embed-text:v1.5` for embeddings) and trains nothing of its own. So every template here is answered **no** or **partially**, never **yes**.

That's the point of the section. These are interview thought-experiments plus a map of the ML-feature surfaces buffr *could* grow into — written so the reader can walk the canonical architecture confidently and then say honestly, "buffr doesn't do this, and here's the smallest version it could."

Same **fixed 9-bullet shape** as section 07: prompt, standard architecture, data model, key components, scale concerns, eval framing, common failure modes, applies-to-codebase, how-to-make-it-apply. No per-concept Zoom-out / How-it-works / Project-exercises.

## The templates

- **`01-recommender-system.md`** — Applies: **no.** buffr recommends nothing; single user, no catalog. The only ranking surface is "which chunk/memory to surface next," reframed as a degenerate recommender. Honestly a stretch.
- **`02-anomaly-detection.md`** — Applies: **partially (as a thought experiment).** buffr's trace metrics — `tokens_used`, tool `durationMs`, warning/error events in `agents.messages` — *are* a stream you could flag anomalies on. The LLM analog is hallucination detection.
- **`03-object-detection-cv.md`** — Applies: **no.** No camera, no CV, no vision anywhere in buffr. Walked as the canonical architecture without forcing a buffr mapping.

The recurring lesson: buffr's ML-shaped surfaces are all *post-hoc analysis of its own trace stream*, not a trained model in the product path.

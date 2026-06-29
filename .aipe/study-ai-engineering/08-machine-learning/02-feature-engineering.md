# Feature engineering — raw signal → engineered feature vector

*Industry standard (feature engineering / representation). buffr does none by hand — its features come pre-baked from nomic-embed-text:v1.5. Not yet implemented.*

## Zoom out, then zoom in

The FEATURES stage of the pipeline (`01-supervised-pipeline.md`) is where a model's accuracy is mostly decided — and it's the one stage buffr quietly *already gets for free*, because a pre-trained encoder hands it a 768-dim vector per chunk without anyone hand-crafting a single feature. This file teaches the hand-crafting buffr skips, then marks honestly where buffr's automated features sit.

```
  Zoom out — features in the pipeline; buffr's are auto, not hand-made

  ┌─ Provider (Ollama) ──────────────────────────────────────────┐
  │  nomic-embed-text:v1.5 ──► vector(768)  ← AUTOMATED features  │
  │  (representation learning: features for free, no hand-craft)  │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ stored as
  ┌─ Storage (Supabase) ─────────▼────────────────────────────────┐
  │  agents.chunks.embedding  vector(768)                         │
  │  agents.messages  ← raw trajectory signal (UN-featurized)     │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hand feature-engineering WOULD attach here
  ┌─ ML FEATURES — ★ NOT PRESENT ★ ─▼─────────────────────────────┐ ← we are here
  │  scaling · encoding · interactions · temporal · text→features │
  │  (buffr engineers NONE of these by hand)                      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **feature engineering** is turning raw signal into the fixed-width numeric vector a model can actually learn from — and choosing *what the model is allowed to notice*. The industry rule of thumb is blunt: **features contribute 60–80% of the result, the model contributes ~10%.** buffr does zero hand-crafting; its only features are the embeddings nomic-embed-text emits, which is genuinely a form of feature engineering — automated representation learning — just not the kind you do by hand. The contrl pose pipeline rhymes here: turning raw pose landmarks into joint angles was hand feature-engineering; you've done this before, on a different signal.

## Structure pass

**Layers:** raw signal (bottom) → engineered features → the vector the model consumes (top).

**Axis — "how much does the model get to see, and who decided?"** Trace it up the stack.

```
  trace "what does the model SEE, and who chose it?"

  ┌─ raw signal ─────┐  everything, unusable shape
  │ trajectory rows  │  (model can't eat this directly)
  └────────┬─────────┘
  ┌─ engineering ────┐  YOU choose: scale, encode, combine, aggregate
  │ transforms       │  ← this is where accuracy is mostly won or lost
  └────────┬─────────┘
  ┌─ feature vector ─┐  exactly what you exposed, nothing more
  │ fixed-width nums │  (model is blind to anything you didn't engineer)
  └──────────────────┘

  the model's ceiling is set HERE, before training starts
```

**The seam:** the boundary between hand-crafted features and *learned* features. On the hand side, a human picks the representation (joint angles, token counts). On the learned side, a pre-trained encoder picks it for you (nomic-embed-text turns text into 768 numbers it learned during its own training). The axis-answer flips across that seam — *who decided the representation* — and buffr lives entirely on the learned side: it never hand-engineers, it consumes an encoder's output. That's the honest framing for the whole file.

## How it works

### Move 1 — the mental model

You already do feature engineering every time you normalize props before passing them to a component. Raw API gives you `{ created_at: "2026-06-19T..." }`; your component needs `daysAgo: 9`. You don't pass the raw string — you derive the number the UI can actually use. Feature engineering is that, at scale, for a model: take raw fields, derive the numeric quantities the model can learn from, and *drop the shapes it can't use*.

```
  PATTERN — raw row → engineered feature vector

  raw row (mixed types, unusable)        engineered vector (numeric, fixed)
  ┌─────────────────────────────┐        ┌──────────────────────────────┐
  │ created_at: "2026-06-19..." │  ───►  │ recency_days:      9         │
  │ tool_calls: [{...},{...}]   │  ───►  │ tool_call_count:   2         │
  │ tokens_used: 1840           │  ───►  │ tokens_scaled:     0.61      │
  │ role: "assistant"           │  ───►  │ role_is_assistant: 1         │
  │ content: "long text..."     │  ───►  │ embedding[0..767]: 0.02,...  │
  └─────────────────────────────┘        └──────────────────────────────┘
   strings, arrays, timestamps             only numbers the model can fit
```

The strategy: every transform below is a way to turn one messy field into model-usable numbers without leaking the answer.

### Move 2 — the step-by-step walkthrough

Five families of transform, one per sub-heading. Each takes a raw field and emits numbers.

**Numeric scaling / normalization.** Raw numbers live on wildly different scales — `tokens_used` in the thousands, `tool_call_count` in single digits. Many models (anything distance- or gradient-based) let the big-magnitude feature dominate purely because it's big. Scaling fixes that: standardize to mean-0 / std-1, or min-max to [0,1].

```
  Numeric scaling — put features on a comparable scale

  raw          standardized (z = (x - mean) / std)
  ─────        ────────────────────────────────────
  tokens=1840    0.61   ┐
  tool_calls=2  -0.30   ├─ now comparable; no single feature
  turns=6        0.15   ┘   dominates by raw magnitude alone
```

Boundary condition: compute mean/std on the **train split only**, then apply to val/test. Fit the scaler on the whole dataset and you've leaked test statistics into training — a quiet form of the leakage `03-train-val-test.md` is about.

**Categorical encoding.** A model can't read `role: "assistant"`. You encode categories into numbers — three common ways, each with a tradeoff.

```
  Categorical encoding — three ways to turn "assistant" into numbers

  ONE-HOT          TARGET (mean-encode)        EMBEDDING
  ───────          ────────────────────        ─────────
  role=tool   →    role=tool → 0.12            role → learned
   [1,0,0]         (avg label for this role)    dense vector
  role=user   →    cheap, leak-prone:           (what nomic-embed
   [0,1,0]          must compute on TRAIN only    does for text)
  small cardinality  high cardinality           huge cardinality
```

One-hot for a few categories; target-encoding for many (but compute the per-category mean on train only, or you leak the label); embeddings for huge-cardinality or text. The boundary condition is target-encoding's leak: the encoded value *is derived from the label*, so it must never see val/test rows.

**Interactions.** Sometimes the signal isn't in any single feature but in a *combination*. A run with many tool calls *and* an error is suspicious; either alone is fine. Linear models can't discover that on their own — you hand them the product feature `tool_calls × had_error`.

```
  Interactions — combine features the model can't combine itself

  tool_calls │ had_error │ interaction (product)
  ───────────┼───────────┼──────────────────────
       5     │     0     │        0      (fine)
       1     │     1     │        1      (one error, low effort)
       6     │     1     │        6      ← the suspicious case pops out
```

Tree models find interactions automatically; linear models (`04-model-selection.md`) need you to engineer them.

**Temporal / aggregate features.** Raw events become features by *aggregating over a window or a unit*. One trajectory has many `agents.messages` rows; you collapse them into per-conversation aggregates: total turns, total tokens, max tool latency, count of warnings.

```
  Temporal / aggregate — many rows → one feature vector per unit

  agents.messages (one conversation_id, N rows)   aggregate
  ───────────────────────────────────────────     ──────────────
  step, step, tool_call, tool, model_usage...  ─► turn_count:    6
  tokens_used per model_usage row              ─► tokens_total: 1840
  durationMs per tool_results                  ─► max_tool_ms:   920
  warning/error events                         ─► error_flag:    0
                                                  (one row the model fits)
```

This is exactly the FEAT-1 exercise below, and it's the natural unit because the model predicts *per conversation*, not per message.

**Text → features.** Free text is the hardest raw signal. Classic options: bag-of-words / TF-IDF (count word occurrences), or — the modern default — feed it through a pre-trained encoder and use the output vector. **This is the one buffr already does.** `nomic-embed-text:v1.5` turns chunk text into a `vector(768)`, stored in `agents.chunks.embedding` and searched in `src/pg-vector-store.ts`.

```ts
// src/pg-vector-store.ts:67-78 — the 768-dim feature vector in use
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);                         // the 768-dim feature vector
  const { rows } = await this.pool.query(
    `select id, content, ...,
            1 - (embedding <=> $1::vector) as score  // cosine over learned features
     from agents.chunks
     where app_id = $2
     order by embedding <=> $1::vector
     limit $3`, ...);
}
```

The honest read: nobody at buffr hand-engineered those 768 numbers. nomic-embed-text *learned* the representation during its own pre-training (representation learning), and buffr gets the features for free. That's still feature engineering — just automated, and outsourced to a pre-trained encoder. What buffr does *not* do is engineer features over its trajectory signal in `agents.messages`; that's untouched.

### Move 3 — the principle

Features set the model's ceiling before training starts — the model can only learn from what you exposed, and it's blind to everything you didn't. That's why features dominate the result and the model choice is a smaller lever: you can't out-fit a representation that doesn't contain the signal. The modern shift is that for text and images, a pre-trained encoder does the representation work for you — which is precisely buffr's situation: it skips hand-crafting because it inherited a good representation. The skill that survives that shift is knowing *when* the free representation is enough (buffr's retrieval) and when you still need hand-crafted features (anything over the trajectory signal, which no encoder gives you for free).

## Primary diagram

Every transform family, raw input to engineered output, with buffr's reality marked.

```
  Feature engineering — the five transform families, buffr's reality

  RAW SIGNAL                         ENGINEERED FEATURES (model input)
  ┌──────────────────┐
  │ tokens_used=1840 │── SCALING ───► z=0.61   (fit scaler on TRAIN only)
  │ role="assistant" │── ENCODING ──► one-hot / target / embedding
  │ tool_calls × err │── INTERACT ──► product feature (linear models need it)
  │ N message rows   │── AGGREGATE ─► turn/tool/token/error per conversation_id
  │ chunk text       │── TEXT→VEC ──► vector(768)  ★ buffr DOES this (auto) ★
  └──────────────────┘                            via nomic-embed-text:v1.5

  buffr reality:
    ✓ TEXT→VEC   (free, from pre-trained encoder → agents.chunks.embedding)
    ✗ everything else (no hand-crafted features over agents.messages signal)

  rule of thumb: features ≈ 60–80% of result · model ≈ 10%
```

## Elaborate

Feature engineering was *the* job in classical ML before deep learning — Kaggle was won on it, and "feature stores" exist as production infrastructure precisely because computing features consistently across train and serve is hard (the parity problem from `01`). The "features dominate" rule comes out of that era and still holds for tabular data. Deep learning's big move was *learned* features: instead of a human designing the representation, the network learns it from raw input — which is exactly what an embedding model like nomic-embed-text is, a frozen learned feature extractor you can call. So buffr sits on the modern side of this history: it never hand-engineers because it consumes a learned representation. The contrl pose pipeline sat on the *classical* side — you hand-derived joint angles from landmarks, which is textbook feature engineering. Holding both in your head is the lesson: the discipline didn't disappear, it moved to "pick and validate the right pre-trained encoder," plus hand-crafting for any signal (like trajectories) no encoder covers.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Engineer trajectory features from agents.messages

- **Exercise ID:** FEAT-1 (Case B — feature engineering not yet implemented). **The core exercise: build the one feature representation buffr's signal needs and no encoder provides.**
- **What to build:** a function that reads all `agents.messages` rows for one `conversation_id` and emits a feature vector — `turn_count`, `tool_call_count`, `tokens_total` (sum of `tokens_used`), `error_flag` / `warning_flag` (from the `error`/`warning` event rows), and `max_tool_ms` / `total_tool_ms` (from `durationMs` inside `tool_results`). Scale the numerics with stats fit on the train split only.
- **Why it earns its place:** this is the FEATURES stage for PIPE-1 and the representation no pre-trained model hands buffr — the only place buffr would do *real* hand feature-engineering. The "I turned my agent's raw trajectory into a model-ready vector" story.
- **Files to touch:** read the schema written by `src/supabase-trace-sink.ts` (`agents.messages` columns); put the feature function next to `src/cli/eval-cmd.ts` so the classifier and the scorer share it (parity).
- **Done when:** given a `conversation_id`, the function returns a fixed-width numeric vector, and the *same* function is callable from both training and serving.
- **Estimated effort:** 1 day.

### Add cheap retrieval-quality features alongside the cosine score

- **Exercise ID:** FEAT-2 (Case B — retrieval features not yet implemented).
- **What to build:** extend the `search()` result in `src/pg-vector-store.ts` with cheap per-hit features beyond the bare cosine score — e.g. score gap to the next hit, hit-count above a threshold, `chunk_index` position, content length — as inputs a future learned reranker (`04-model-selection.md`, SEL-1) could consume.
- **Why it earns its place:** the cosine score is a single feature; a reranker needs a vector. This builds the feature surface that makes a learned reranker possible, on buffr's one real ML-adjacent path.
- **Files to touch:** `src/pg-vector-store.ts` (the `search()` mapping at lines 67–85); consumed later by an eval/reranker harness next to `src/cli/eval-cmd.ts`.
- **Done when:** each hit carries a small feature vector (not just `score`), and the eval harness can read it.
- **Estimated effort:** 4–8hr.

## Interview defense

**Q: How much does feature engineering actually matter versus picking the right model?**
Answer: features set the ceiling — roughly 60–80% of the result, with the model around 10%. The model can only learn from what the features expose; it's blind to anything you didn't engineer in. So I spend my attention on representation: scaling so no feature dominates by magnitude, encoding categories without leaking the label, engineering interactions linear models can't find, and aggregating raw events into per-unit vectors. You can't out-fit a representation that doesn't contain the signal.

```
  features (ceiling) ──────────────────► model (fits under the ceiling)
   60–80% of result                        ~10%
```

**Q: buffr does no feature engineering — is that a gap?**
Answer: not for retrieval — buffr gets its features *for free* from `nomic-embed-text:v1.5`, which emits a `vector(768)` per chunk stored in `agents.chunks.embedding`. That's automated representation learning; nobody hand-crafted those numbers. **The part people forget: an embedding model IS feature engineering, just learned and outsourced — so buffr isn't skipping the FEATURES stage, it's inheriting it.** The genuine gap is over `agents.messages`: no encoder turns a trajectory into features, so if buffr ever modeled its own runs, that's the one place real hand-crafting is required.

```
  text ──► nomic-embed ──► vector(768)   features for free (buffr has this)
  trajectory ──► (no encoder) ──► must hand-engineer (buffr's real gap)
```

## See also

- `01-supervised-pipeline.md` — the FEATURES stage this file opens up.
- `03-train-val-test.md` — why scalers/encoders must be fit on the train split only (leakage).
- `04-model-selection.md` — linear models need engineered interactions; trees find them.
- `../03-retrieval-and-rag/` — where buffr's embedding features are actually produced and used.
- `../05-evals-and-observability/04-llm-observability.md` — the trajectory signal FEAT-1 turns into features.

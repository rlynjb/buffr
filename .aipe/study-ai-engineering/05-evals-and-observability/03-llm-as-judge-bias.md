# LLM-as-judge and its biases

### The faithfulness oracle buffr built but never wired — and the three ways a model judge lies

This is the rung `02` stopped at. When the oracle has to grade *meaning* — "is this answer faithful to the chunks it cited?" — no arithmetic suffices; you hand the comparison to a model. That oracle is the **LLM-as-judge** (the unwired `RubricJudge`). buffr's eng stack *contains* it — it lives, fully built, in aptkit. buffr just never constructs it. So the single most important generation-quality question — *is the answer grounded?* — is, today, unmeasured.

```
THE EVAL STACK — the judge rung, present but dark
┌──────────────────────────────────────────────────────────────┐
│  Method ladder       ... LLM-as-judge ◄── THIS FILE (the gap) │
│                      RubricJudge: built in aptkit, UNWIRED    │
├──────────────────────────────────────────────────────────────┤
│  What it would grade  FAITHFULNESS — answer vs. retrieved     │
│                       chunks (not retrieval identity)         │
├──────────────────────────────────────────────────────────────┤
│  buffr today          measures retrieval (02); NOT this       │
└──────────────────────────────────────────────────────────────┘
```

Lead with the gap because it's the headline: buffr can prove the right chunks were fetched and cannot prove the answer used them. Everything below is how you'd close it — and how the judge can fool you while you do.

## Structure pass

The axis here is **what the judge sees vs. what biases that exposes.** An LLM judge is a model reading a prompt; everything that warps a model reading a prompt — order, length, authorship — warps the judge. There are three classic biases, and one of them (self-preference) is a live trap in buffr's local-only setup.

```
ONE AXIS — what the judge reads ──► which bias it triggers
  reads A then B ──────────► POSITION bias    (favors first/last)
  reads a long answer ─────► VERBOSITY bias   (mistakes length for quality)
  reads its OWN family's ──► SELF-PREFERENCE  (favors gemma-style output)
       output                 ▲ LIVE TRAP: gemma2:9b judging gemma2:9b
```

The seam: the `RubricJudge` is designed to *reduce* these biases by forcing structure — a fixed rubric, bounded score ranges, an enumerated verdict set, JSON-only output. Structure narrows the judge's freedom to be swayed. But structure can't fix self-preference, because that bias lives in the model's *weights*, not its prompt. So wiring the judge is necessary; choosing a *different model family* to judge is the part the harness can't do for you.

## How it works

### Move 1 — mental model: a judge is a model with a scoring contract bolted on

A raw LLM asked "rate this answer" gives you mush — inconsistent scales, prose, no structure. The `RubricJudge` turns that into an oracle by wrapping the model in three constraints: a **rubric** (named dimensions with explicit score scales), a **structured-output demand** (JSON in an exact shape), and a **validator** (reject anything off-rubric). The model still does the judging; the wrapper makes its verdict machine-readable and range-checked.

```
THE RUBRIC-JUDGE PATTERN
   rubric ─────► system prompt    ┌─ dimensions (id, scale 0..n)
   (RubricDefinition)             ├─ allowed verdicts
                                  └─ checks (booleans)
                                         │
   subject + context ─► user prompt      ▼
                              generateStructured(model, validate)
                                         │
                          JSON { dimensions:{id:{score,reason}},
                                 checks, verdict, fix, reasoning }
                                         │
                              validator: score in [min,max]?
                                         verdict allowed?  ──► RubricJudgment
```

Bridging from schema validation you know: this is a Zod-style validator over a model's output. The novelty is that the thing being validated is a *judgment*, and the validator's job is to make the judge's freedom bounded — it literally rejects a score outside the rubric's declared range (`rubric-judge.ts:196`).

### Move 2 — the unwired RubricJudge, in detail

Everything below is real code in aptkit. None of it is called from buffr. That's the gap, made concrete.

**It exists, fully, in aptkit.** `RubricJudge` is a class with a `judge()` method. Constructing it needs a `model` and a `rubric`. buffr never imports it — `grep RubricJudge src/` in buffr returns nothing.

```
aptkit evals/rubric-judge.ts:72  class RubricJudge
              :89  judge(input) → generateStructured({ model, system, validate, ... })

buffr  src/  →  no import, no construction, no call   ← THE GAP
        (compare: src/cli/eval-cmd.ts uses scorePrecisionAtK only)
```

**The system prompt is built from the rubric.** `buildRubricJudgeSystemPrompt` (`rubric-judge.ts:107`) renders each dimension's score scale, the allowed verdicts, the boolean checks, and an exact output shape. The judge is *told* the scale, so two runs grade against the same ruler.

```
rubric-judge.ts:107 buildRubricJudgeSystemPrompt(rubric)
   "You are a rubric judge for: {title}."
   dimensions:  {id} {label}: {desc}        ← per dimension...
                  0 = {desc}   1 = {desc}    ←   ...its score scale
   Allowed verdicts: - pass: ...  - fail: ...
   "Output JSON only. Use exactly this shape:" {dimensions:{id:{score,reason}}, ...}
```

**The validator enforces the contract.** `createRubricJudgmentValidator` (`rubric-judge.ts:170`) rejects any output that isn't an object, any dimension score that's not a number, any score outside the rubric's `[min,max]`, and any verdict not in the allowed set. This is the structural defense against a judge that drifts off-scale.

```
rubric-judge.ts:193  score.score must be a number
              :196  score.score in [range.min, range.max]   ← bounded judgment
              :202  verdict ∈ allowed set                    ← no invented verdicts
```

**What a buffr faithfulness rubric would look like.** To measure grounding, the `subject` is the generated answer, the `context` is the retrieved chunks, and the dimensions grade *support*. None of this exists yet — it's the [B3.9] payload.

```
   faithfulness rubric (to build)
     dimension "grounding"  scale 0..2
        0 = claims contradict / aren't in the chunks
        1 = partially supported
        2 = every claim traceable to a cited chunk
     check  "all citations point to a retrieved docId" : boolean
     verdict  pass | fail
```

### Move 2.5 — current vs. future: the faithfulness column is empty

State it bluntly. buffr measures retrieval; the faithfulness column is blank, and the tool to fill it is sitting unused one package over.

```
                    buffr today              after [B3.9]
 retrieval P@k/R@k    ████ measured           ████ measured
 faithfulness         ░░░░ UNMEASURED         ████ RubricJudge wired over
   (answer grounded?)   ▲ RubricJudge exists      eval/queries.json
                          in aptkit, never called
```

The consequence is concrete: right now an answer that retrieves `work.md` (P@1 = 1.00) and then states a job `work.md` never mentions passes every buffr eval. The hallucination is invisible. Wiring the judge is the only thing that makes it visible.

### Move 3 — the principle, and the three biases

**A model judge is an oracle with opinions — bound it with structure, and never let it grade its own family.** The `RubricJudge`'s rubric, ranges, and validator bound the *prompt-level* biases. The model-level bias they can't touch is self-preference, and you defeat that by choosing the judge model, not by improving the prompt.

```
   BIAS              MECHANISM                       FIX
   position    judge favors first/last answer        randomize order; judge each
                                                      answer alone (no A/B)
   verbosity   long answer reads as "thorough"       rubric scores SUPPORT not
                                                      length; cap subject length
   self-       gemma2:9b rates gemma-style output     ← JUDGE WITH A DIFFERENT
   preference    higher                                 FAMILY (not gemma)
```

The self-preference trap is *live* in buffr: it runs `gemma2:9b` locally for generation. The lazy faithfulness eval reuses the same `gemma2:9b` to judge — and it will systematically over-score its own outputs, because the answer "looks right" to the same weights that wrote it. The fix isn't a better prompt; it's a different judge model (a non-gemma local model, or a hosted judge), accepting the cost.

## Primary diagram

The judge, its contract, its biases, and buffr's dark wiring.

```
                  LLM-AS-JUDGE (the unwired RubricJudge)
   answer ──┐
   chunks ──┼─► RubricJudge.judge()  [aptkit rubric-judge.ts:89]   ✗ buffr never calls
            │      │ system = rubric (dims, scales, verdicts)
            │      │ generateStructured(model)
            │      │ validate: scores in range, verdict allowed   ← bounds PROMPT bias
            │      ▼
            │   { dimensions:{grounding:{score,reason}}, verdict, fix }
            │
   BIASES NOT FIXED BY STRUCTURE:
     position ─ randomize/solo    verbosity ─ score support    self-pref ─ DIFFERENT FAMILY
                                                                 ▲ gemma≠gemma TRAP
   buffr today:  retrieval measured ·  FAITHFULNESS unmeasured (RubricJudge dark)
```

## Elaborate

Why self-preference is the bias to fear most in *this* repo, specifically: position and verbosity bias assume you're comparing two answers or grading length — both are partly designable away in the rubric. Self-preference assumes the judge and the author share weights, and buffr's whole premise is *one local model on your laptop*. The path of least resistance — "I already have gemma2:9b loaded, I'll judge with it" — walks straight into the worst bias, because there's only one model in the box. The honest faithfulness eval for buffr must either pull a second model family into Ollama or call out to a hosted judge, and that cost is part of the exercise, not a footnote.

Why a *structured* judge beats a free-text "rate 1–10" judge for grounding: faithfulness has a verifiable substructure — every claim either traces to a chunk or it doesn't. A free-text judge collapses that to one fuzzy number. The `RubricJudge`'s per-dimension `reason` field and boolean `checks` (e.g. "all citations point to a retrieved docId") force the judge to *show its work* per claim, which both improves the judgment and gives you a debuggable artifact — you can read *why* it said unfaithful, not just *that* it did. That `reason` field is also what you'd spot-check against human labels to calibrate the judge before trusting it.

## Project exercises

### Wire RubricJudge into a faithfulness eval over the golden set

- **Exercise ID:** [B3.9] (cite [C3.9], Phase 3) — Case B: `RubricJudge` exists in aptkit but is **never constructed in buffr**; faithfulness is unmeasured. This exercise is primary.
- **What to build:** A new eval that, for each query in `eval/queries.json`, runs the full `RagQueryAgent`, then constructs a `RubricJudge` with a grounding rubric (subject = answer, context = retrieved chunks) and records a faithfulness score + verdict + the one-line `fix`. Crucially, configure the judge with a **non-gemma** model family to dodge self-preference.
- **Why it earns its place:** It closes the single biggest measurement gap in buffr — an answer can score P@1 = 1.00 and still hallucinate. This turns "grounded" from a prompt instruction into a number, using a tool already built one package away.
- **Files to touch:** new eval beside `src/cli/eval-cmd.ts` importing `RubricJudge` from aptkit; drive the agent via `src/session.ts`; retrieved chunks from `src/pg-vector-store.ts`; a second Ollama model for the judge (config in `src/config.ts`).
- **Done when:** `npm run eval` (or a sibling command) prints a faithfulness score per golden query, the judge runs on a different family than gemma2:9b, and you can name a query where the answer drifts off its citations.
- **Estimated effort:** 2–3 days.

### Calibrate the judge against hand labels and measure its biases

- **Exercise ID:** [B3.10] (cite [C3.10], Phase 3) — Case B: builds on [B3.9]; no judge calibration exists.
- **What to build:** Hand-label faithfulness for the golden queries, compare against the judge's verdicts, and run two bias probes: feed the judge a padded vs. terse version of the same answer (verbosity), and gemma-authored vs. non-gemma-authored answers of equal quality (self-preference). Report the disagreement.
- **Why it earns its place:** An uncalibrated judge is just a confident guess. This proves the judge agrees with you *and* quantifies how much its biases move the score — the difference between a trusted oracle and a vibe.
- **Files to touch:** the [B3.9] eval; a small `eval/faithfulness-labels.json`; the rubric definition.
- **Done when:** You can state the judge's agreement rate with your labels and show a measured verbosity/self-preference delta on equal-quality answers.
- **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Does buffr measure whether its answers are grounded?"**

No — and that's the honest headline of this whole sub-section. buffr measures *retrieval* (precision@k/recall@k on docIds) but not *faithfulness*: whether the answer's claims trace back to the retrieved chunks. The tooling exists — aptkit ships a `RubricJudge` (a model judge with a rubric, bounded score ranges, and a validator) — but buffr never constructs it. So an answer can retrieve the right document and still hallucinate, and every current eval passes. [B3.9] wires the judge to close exactly this.

```
   retrieval  ✓ measured (P@k/R@k)
   grounded?  ✗ unmeasured ── RubricJudge built in aptkit, never called in buffr
```

*Anchor: the right chunks retrieved is not the same as the chunks actually used — and only a judge sees the difference.*

**Q: "You're on a single local model. How would you run a judge without fooling yourself?"**

By refusing to let gemma2:9b grade gemma2:9b. That's self-preference bias: a model over-scores output that looks like its own, and it lives in the weights, so no rubric tuning fixes it. The structural biases — position, verbosity — the `RubricJudge` already curbs by scoring support over length and judging answers solo rather than A/B. Self-preference I curb by pulling a *different* model family into the judge seat (a second Ollama model, or a hosted judge), and I pay that cost knowingly because the alternative is a faithfulness number I can't trust.

```
   prompt-level bias (position, verbosity) → rubric + validator handle it
   weight-level bias (self-preference)     → MUST swap model family (gemma ≠ judge)
```

*Anchor: a judge that shares weights with the author isn't a judge, it's a mirror.*

## See also

- **`02-eval-methods.md`** — the rung below; why exact-match can't see faithfulness.
- **`01-eval-set-types.md`** — the golden set the faithfulness judge runs over.
- **`04-llm-observability.md`** — where the judged trajectories (and their chunks) are recorded for replay.
- **`../01-llm-foundations/`** — `generateStructured` and the JSON-validation contract the judge rides on.
- **`../03-retrieval-and-rag/11-rag.md`** — the grounding contract this eval would finally test.

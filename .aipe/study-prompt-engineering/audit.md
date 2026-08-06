# Audit — the 13 prompt-engineering lenses against buffr-laptop

Pass 1 of the two-pass shape. One section per concept lens. Each names what the repo actually does with `file:line` grounding, or emits `not yet exercised` honestly. Significant findings cross-link to their concept file rather than restating the walk.

The honesty rule matters here. A guide that claims buffr does few-shot prompting because a dependency *could* is a guide you can't trust. Where the machinery exists in a package but buffr's real path never fires it, I say so.

---

## 1. Anatomy of a production prompt — EXERCISED

Three of the four classic sections are present and assembled across three owners. System prompt = `DEFAULT_SYSTEM_TEMPLATE` (`packages/kernel/src/agents/rag-query-agent.ts:13-20`, formerly `BASE_SYSTEM`) **plus a routing prompt** built in `session.ts:569-594` listing 7 tool-usage rules and every active tool (search_knowledge_base, RSS, Amazon reviews, Tavily/Brave/Google web search connectors). Context injection = profile prepended by `injectProfile` (`packages/kernel/src/agents/prompt-helpers.ts:15`). User message = the question (`session.ts:674`). Few-shot examples = the missing fourth section. → see [01-anatomy.md](01-anatomy.md).

## 2. Structured outputs via tool calling — EXERCISED (load-bearing, deeper now)

Tool calling is **emulated**, not native. Gemma 2 9B has no tool API, so `GemmaModelProvider.buildSystemText` renders the tool catalog as JSON text and demands a JSON reply (`packages/kernel/src/model-gateway/gemma-provider.ts:82-110`). The reply is parsed back with `parseToolCall` (`:128`), gated on a cheap `{`-tell via `looksLikeToolAttempt` (`:153`), and given exactly one corrective retry with `RETRY_NUDGE` (`:29`).

**New: the same kernel, reused across three capabilities.** `Analyzer` (`submit_analysis`) and `Teacher` (`submit_explanation`) both run through `runAgentLoop` against the same `GemmaModelProvider` instance the RAG agent uses (`session.ts:447,517,561` — one `model` shared by `RagQueryAgent`, `InvestingEngine`, `MarketResearchEngine`). Same render→ask→parse→retry mechanism, three different tool schemas — self-similarity worth naming.

**New: Teacher adds a field-level fallback the kernel doesn't cover.** `Teacher.execute()` (`packages/capabilities/src/teacher/index.ts:110-125`) now emits a structured `principle` + `reflectionQuestion` alongside `explanation`/`keyLessons`/`actionableNext`. When the tool call parses fine but an individual field comes back empty — `required` in JSON Schema guarantees presence, not non-empty content — `Teacher` substitutes a deterministic value derived from data already in hand (`fallbackPrinciple`, `:40-44`) or a fixed string (`FALLBACK_REFLECTION_QUESTION`, `:46`), with **no retry, no second model call**. Locked down by regression tests in `packages/capabilities/test/teacher.test.ts:105-150` (one asserting the fallback fires and names the strongest dimension, one asserting a model-supplied value passes through untouched).

The generic structured-output reprompt (`generateStructured` + `DEFAULT_STRICT_SUFFIX`, `packages/kernel/src/workflow-runtime/structured-generation.ts`) exists in `@buffr/kernel` but no path in buffr calls it. → see [02-structured-outputs.md](02-structured-outputs.md).

## 3. Prompts as code: versioning + observability — PARTIAL (reframed, gap narrowed)

`DEFAULT_SYSTEM_TEMPLATE` lives in `@buffr/kernel` (`packages/kernel/src/agents/rag-query-agent.ts`), a **local npm workspace package in this same repo** (correcting last audit's "someone else's repo" framing — it's not an external dependency). buffr's must-not-change constraint: *"monorepo packages are consumed, not edited at root"* (`context.md`); a real change requires a source edit in `packages/kernel/src/` plus `npm run build:packages`, not a version bump. The routing prompt (`session.ts:569-594`) is directly in buffr's own source and now registered in a `PromptRegistry` (`packages/kernel/src/prompt-registry/index.ts`) under `'rag-query-agent/routing'` + `ROUTING_PROMPT_VERSION`.

**New: prompt-as-data is now a confirmed reused pattern, not a one-off.** `packages/domain-packs/investing/src/prompts.ts` and `packages/domain-packs/market-research/src/prompts.ts` are both a bare `Record<string,string>` with the identical two keys (`'analyzer-context'`, `'teacher-context'`), consumed the same way — `engine.ts:144,174` inject the string into `Analyzer`/`Teacher`'s `instructions[]` field. Two domain packs, same shape, same consumption path: this is load-bearing now, not an aside.

**Corrected: the "no prompt-version stamp" gap is narrower than previously stated.** `agent.promptVersion` **is** computed per turn (`RagQueryAgent` resolves it from the `PromptRegistry` entry, `rag-query-agent.ts:38-56`) and reaches `session.ts:682`'s `onComplete` callback — but it stops there. It never reaches `supabase-trace-sink.ts` or the `agents.messages` insert, so a SQL query still can't answer "which prompt made this output." Closing it is threading an existing value one hop further, not new plumbing. → see [03-prompts-as-code.md](03-prompts-as-code.md).

## 4. Token budgeting + context window — EXERCISED

A hard guard. `ContextWindowGuardedProvider` wraps Gemma with `maxTokens: 8192` (`session.ts:447`), estimates input tokens at ~3 chars/token (`packages/kernel/src/model-gateway/context-window-guard.ts`), and **throws** rather than truncates. Analyzer's evidence excerpts are separately capped at 500 chars per item (`EVIDENCE_EXCERPT_CHARS`, `analyzer/index.ts:62,74`) — a token-budget control, not a security one (see lens 12). Prefix caching: not exercised (Ollama local). → see [04-token-budgeting.md](04-token-budgeting.md).

## 5. Eval-driven iteration — PARTIAL (retrieval + Scorer + a new fallback-path regression test)

Three eval surfaces now exist:
1. **Retrieval eval** (`eval/queries.json` → `src/cli/eval-cmd.ts`): P@1/R@3 over labeled queries.
2. **Scorer accuracy eval** (`packages/domain-packs/*/eval/*.json` → `/eval` command): asserts scorecard weights produce expected `totalScore` values within tolerance. Deterministic math, not LLM output.
3. **New: Teacher's fallback-path regression test** (`packages/capabilities/test/teacher.test.ts:105-150`) — pins both branches of the principle/reflectionQuestion fallback. First eval in the repo aimed at a *structured-output fallback path* specifically, not just end-to-end correctness.

The generation-quality gap remains: neither the RAG answer nor the Analyzer/Teacher explanation is evaluated for faithfulness. → see [05-eval-driven-iteration.md](05-eval-driven-iteration.md).

## 6. Single-purpose chains — PARTIAL (three paths now, each one job)

buffr runs three distinct single-purpose computation paths: the RAG query agent, `InvestingEngine`, and `MarketResearchEngine`. Each composes single-purpose capabilities (Collector, Analyzer, Scorer, Teacher) with a domain pack. None composes into another; dispatch is a slash-command prefix check in `chat.tsx`, not a classifier LLM. → see [06-single-purpose-chains.md](06-single-purpose-chains.md).

## 7. Output mode mismatch — EXERCISED (implicitly)

The RAG agent's synthesis turn returns free prose; the model internally alternates between a JSON tool call and prose, disambiguated at parse time (`looksLikeToolAttempt`). → see [07-output-mode-mismatch.md](07-output-mode-mismatch.md).

## 8. Few-shot prompting — NOT YET EXERCISED

No examples in any prompt, including the newer Analyzer/Teacher tool schemas — the schema and field descriptions are the only shape guidance given. Primary buildable target. → see [08-few-shot.md](08-few-shot.md).

## 9. Chain-of-thought — NOT YET EXERCISED

No reasoning prompt anywhere, including the newer capabilities. Curriculum target. → see [09-chain-of-thought.md](09-chain-of-thought.md).

## 10. Self-critique / self-consistency — NOT YET EXERCISED

Every capability (RAG synthesis, Analyzer, Teacher) answers once. Curriculum target. → see [10-self-critique.md](10-self-critique.md).

## 11. Meta-prompting — NOT EXERCISED in buffr; canonical in aipe

buffr does not use an LLM to write its own prompts. → see [11-meta-prompting.md](11-meta-prompting.md).

## 12. Prompt injection defense (author side) — PARTIAL (three holes now, one new and higher-risk)

One real defense, three real holes. Defense: the profile is injected under a labeling heading (`PROFILE_HEADING`, `rag-query-agent.ts:22`). Hole 1: retrieved chunks concatenated into tool results with no delimiter. Hole 2 (second-order): recalled memory re-injects prior model output the same unmarked way. **Hole 3 (new): `Analyzer`'s evidence channel.** `evidenceSummary` (`analyzer/index.ts:73-75`) concatenates every evidence item's excerpt — including Reddit `selftext` (`packages/connectors/src/discovery/reddit-search.ts:107`) and Google `snippet` (`google-search.ts:75`) — into the prompt with zero delimiter and zero "treat as data" framing. Same bare-concatenation pattern as holes 1-2, exercised by a brand-new pipeline, and arguably the highest-risk of the three: the text was never inside buffr's trust boundary — it's unmoderated open-web content anyone can craft. See `study-security`'s `03-indirect-prompt-injection-surface.md` for the trust-boundary audit; from the prompt side, the fix is the same at all three call sites — an explicit "treat the following as UNTRUSTED DATA" framing plus a stated instruction hierarchy. → see [12-prompt-injection-defense.md](12-prompt-injection-defense.md).

## 13. Forbidden patterns / rotating formulas — NOT YET EXERCISED

None of buffr's three paths (RAG, investing, market-research) generates the same *kind* of artifact repeatedly for one user yet. Curriculum target. → see [13-forbidden-patterns.md](13-forbidden-patterns.md).

---

## Notable, not lens-specific: structured input FROM a human, and comparison as pure code

Two small findings that don't map cleanly onto any single lens but are genuinely prompt-engineering-relevant, both in `src/cli/research-flow.ts` and `packages/engines/market-research/src/engine.ts`:

- **`PREDICTION_PROMPT`** (`research-flow.ts:37-42`) asks the *user*, not the model, to reply in an exact shape (`<score> <dimension> <confidence>`). `parsePrediction()` (`:44-54`) parses it with the same discipline as a tool-call parser — validate shape, validate each field, return `null` and re-prompt on failure rather than guess. A mirror of the render/ask/parse/retry kernel aimed at a human. See [02-structured-outputs.md](02-structured-outputs.md) Elaborate.
- **`PredictionComparison`** (`engine.ts:202-208`) — the gap between the user's prediction and the engine's score — is computed as subtraction and equality in TypeScript, never asked of the model. The docstring says it outright: "never asks the model to invent the gap." Once both sides of a comparison are already structured values, comparing them is a code problem, not a prompt problem. See [02-structured-outputs.md](02-structured-outputs.md) Elaborate.

---

## Summary table

```
  lens                          status                primary file
  ────────────────────────────  ────────────────────  ──────────────
  1  anatomy                    EXERCISED              01
  2  structured outputs         EXERCISED ★ (deeper)   02
  3  prompts as code            PARTIAL (reframed,     03
                                 gap narrowed)
  4  token budgeting            EXERCISED              04
  5  eval-driven iteration      PARTIAL (+ fallback    05
                                 regression test)
  6  single-purpose chains      PARTIAL (3 paths)      06
  7  output mode mismatch       EXERCISED              07
  8  few-shot                   NOT YET                08
  9  chain-of-thought           NOT YET                09
  10 self-critique              NOT YET                10
  11 meta-prompting             elsewhere (aipe)       11
  12 injection defense          PARTIAL (3 holes,      12
                                 1 new + higher-risk)
  13 forbidden patterns         NOT YET                13

  ★ = the load-bearing one for this repo
```

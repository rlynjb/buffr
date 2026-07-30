# Audit — the 13 prompt-engineering lenses against buffr-laptop

Pass 1 of the two-pass shape. One section per concept lens. Each names what the repo actually does with `file:line` grounding, or emits `not yet exercised` honestly. Significant findings cross-link to their concept file rather than restating the walk.

The honesty rule matters here. A guide that claims buffr does few-shot prompting because aptkit *could* is a guide you can't trust. Where the machinery exists in `node_modules` but buffr's real path never fires it, I say so.

---

## 1. Anatomy of a production prompt — EXERCISED

Three of the four classic sections are present and assembled across three owners. System prompt = `BASE_SYSTEM` (`agent-rag-query/dist/src/rag-query-agent.js:12`) **plus a routing prompt** built in `session.ts:142-182` listing 7 tool-usage rules and all active tools (search_knowledge_base, RSS, Amazon reviews, web search connectors). Context injection = profile prepended by `injectProfile` (`context/dist/src/profile-injector.js:15`, called at `rag-query-agent.js:29`). User message = the question (`session.ts:62`). Few-shot examples = the missing fourth section. → see [01-anatomy.md](01-anatomy.md).

## 2. Structured outputs via tool calling — EXERCISED (load-bearing)

Tool calling is **emulated**, not native. Gemma 2 9B has no tool API, so `GemmaModelProvider.buildSystemText` renders the tool catalog as JSON text and demands a JSON reply (`provider-gemma/dist/src/gemma-provider.js:82–105`). The model's reply is parsed back with `parseToolCall` (`:107`), gated on a cheap `{`-tell via `looksLikeToolAttempt` (`:127`), and given exactly one corrective retry with `RETRY_NUDGE` (`:2`). The generic structured-output reprompt (`generateStructured` + `DEFAULT_STRICT_SUFFIX`, `runtime/dist/src/structured-generation.js:3`) exists in aptkit but the RAG path does not call it. → see [02-structured-outputs.md](02-structured-outputs.md).

## 3. Prompts as code: versioning + observability — PARTIAL (improved)

`BASE_SYSTEM` lives in `@buffr/kernel` (`packages/kernel/src/agents/rag-query-agent.ts`), but buffr now owns a **routing prompt** directly in `session.ts:142-182` — 7 tool-usage rules, the full tool description block, and conditional logic based on configured connectors. This routing prompt is version-controlled in buffr's source: a PR diff shows exactly which rules changed. It's the first prompt buffr controls directly. Observability exists at the trajectory level via `SupabaseTraceSink`. What's still missing: a prompt-version stamp on each output, and a prompt+model-version pairing. → see [03-prompts-as-code.md](03-prompts-as-code.md).

**New: prompt-as-data pattern** (`packages/domain-packs/investing/src/prompts.ts`). `INVESTING_PROMPTS` is a `Record<string, string>` keyed by `'analyzer-context'` and `'teacher-context'`. The `'analyzer-context'` value is injected as `instructions[]` into `Analyzer.execute()` at engine runtime. This is the **first prompt-as-data pattern** in the monorepo: prompt text stored with the domain knowledge, not hardcoded in the capability implementation. The Analyzer capability is domain-agnostic; the domain pack provides the prompt tuning. Versioning: the prompt text is in the domain-pack package, version-controlled alongside the dimensions and scorecard it was tuned to match. One-way door: changing `INVESTING_PROMPTS` without updating eval fixtures is safe (the Scorer is downstream of the Analyzer, and fixture inputs are pre-computed `findings`, not raw prompts). → see [03-prompts-as-code.md](03-prompts-as-code.md).

## 4. Token budgeting + context window — EXERCISED

A hard guard. `ContextWindowGuardedProvider` wraps Gemma with `maxTokens: 8192` (`session.ts:46`), estimates input tokens at ~3 chars/token (`provider-local/dist/src/context-window-guard.js:64`), reserves 768 for output, and **throws** `ContextWindowExceededError` rather than truncating (`:37`). Tool results are capped at 16,000 chars (`runtime/dist/src/run-agent-loop.js:2`). Prefix caching: not exercised (Ollama local, no provider-side prefix cache claimed). Lost-in-the-middle: relevant since the profile sits at the *front* of a possibly long prompt. → see [04-token-budgeting.md](04-token-budgeting.md).

## 5. Eval-driven iteration — PARTIAL (retrieval + Scorer; still no generation eval)

Two eval surfaces now exist:
1. **Retrieval eval** (`eval/queries.json` → `src/cli/eval-cmd.ts`): P@1 and R@3 over 3 labeled queries. Covers retrieval, not prompts.
2. **Scorer accuracy eval** (`packages/domain-packs/investing/eval/*.json` → `test/commands.test.ts` → `/eval` command): asserts that `COMPANY_SCORECARD`/`ETF_SCORECARD` weights produce expected `totalScore` values within ±0.01. This is the first eval that is also a build-gate test. Still does not evaluate prompt quality — Scorer is deterministic math, not LLM output.

The generation-quality gap remains: neither the RAG answer nor the Analyzer/Teacher explanation is evaluated for faithfulness or accuracy. The `RubricJudge` in aptkit is still unwired. → see [05-eval-driven-iteration.md](05-eval-driven-iteration.md).

## 6. Single-purpose chains — PARTIAL (improved)

buffr now runs two distinct single-purpose computation paths, each with one job:
1. **RAG query agent** (`RagQueryAgent`): answer grounded in KB + web. One job.
2. **InvestingEngine pipeline**: analyze a ticker across 5 dimensions and score it. One job. The Analyzer and Teacher inside it are each single-purpose LLM calls.

Neither composes into the other. The dispatch is a slash-command prefix check in `chat.tsx`, not a classifier LLM. The one-job discipline holds for each path; a composed pipeline of paths doesn't exist yet. → see [06-single-purpose-chains.md](06-single-purpose-chains.md).

## 7. Output mode mismatch — EXERCISED (implicitly)

The agent has exactly one output mode: free prose (the synthesis turn returns plain text, `rag-query-agent.js:49`). The interesting mismatch is *inside* the loop: the model alternates between emitting a **JSON tool call** and **prose**, and the provider has to disambiguate which it got (`looksLikeToolAttempt`, `gemma-provider.js:127`). That's an output-mode boundary handled at parse time. → see [07-output-mode-mismatch.md](07-output-mode-mismatch.md).

## 8. Few-shot prompting — NOT YET EXERCISED

No examples in any prompt. `BASE_SYSTEM` is pure instruction; the tool catalog is schema-only. The tool-call format is described in prose (`"respond with ONLY a single JSON object…"`, `gemma-provider.js:99`) rather than shown as a worked example — which is exactly the place a single few-shot example would buy reliability on a 9B model. Primary buildable target. → see [08-few-shot.md](08-few-shot.md).

## 9. Chain-of-thought — NOT YET EXERCISED

No reasoning prompt. The synthesis instruction asks for a direct, concise answer (`buildSynthesisInstruction`, `run-agent-loop.js:17`; called `rag-query-agent.js:49`) — the opposite of "think step by step." No `thinking` field in any structured output. Curriculum target. → see [09-chain-of-thought.md](09-chain-of-thought.md).

## 10. Self-critique / self-consistency — NOT YET EXERCISED

The agent answers once. No second pass evaluates the answer; no N-sample vote. The loop is bounded (`maxTurns: 6`, `maxToolCalls: 4`, `rag-query-agent.js`) toward *fewer* model calls, not more. Curriculum target. → see [10-self-critique.md](10-self-critique.md).

## 11. Meta-prompting — NOT EXERCISED in buffr; canonical in aipe

buffr does not use an LLM to write its prompts. The canonical example lives in a sibling project (aipe: markdown templates + slash commands that compose prompts). buffr's only meta-shaped data is the profile, which is human-authored, not LLM-generated. → see [11-meta-prompting.md](11-meta-prompting.md).

## 12. Prompt injection defense (author side) — PARTIAL (new surface added)

One real defense, two real holes now. The defense: the profile is injected under a labeling heading (`# About the person you are assisting`, `rag-query-agent.js:20`), which frames it as data. The original hole: retrieved chunks and recalled memory are concatenated into tool results **with no delimiter and no "treat as data" framing** — and memory is *prior model output* re-entering the prompt, which is the classic second-order injection surface. **New hole (higher risk):** web search results from Brave/Tavily/Google are also injected as tool output with no sanitization gate — these are external internet content that anyone can craft to embed injection payloads. See security audit `03-indirect-prompt-injection-surface.md` for the full walk; from a prompt-engineering perspective, the defense would be an explicit "treat the following as UNTRUSTED EXTERNAL DATA" framing around web-result tool outputs. → see [12-prompt-injection-defense.md](12-prompt-injection-defense.md).

## 13. Forbidden patterns / rotating formulas — NOT YET EXERCISED

buffr's agent is a Q&A assistant, not a repeated generative chain, so phrasing convergence hasn't bitten yet. No forbidden-openings list, no rotation history. The concept becomes load-bearing the moment buffr grows a chain that generates the same *kind* of artifact repeatedly for one user. Curriculum target. → see [13-forbidden-patterns.md](13-forbidden-patterns.md).

---

## Summary table

```
  lens                          status              primary file
  ────────────────────────────  ──────────────────  ──────────────
  1  anatomy                    EXERCISED           01
  2  structured outputs         EXERCISED ★         02
  3  prompts as code            PARTIAL             03
  4  token budgeting            EXERCISED           04
  5  eval-driven iteration      PARTIAL (retrieval  05
                                + Scorer fixtures)
  6  single-purpose chains      PARTIAL (improved)  06
  7  output mode mismatch       EXERCISED           07
  8  few-shot                   NOT YET             08
  9  chain-of-thought           NOT YET             09
  10 self-critique              NOT YET             10
  11 meta-prompting             elsewhere (aipe)    11
  12 injection defense          PARTIAL             12
  13 forbidden patterns         NOT YET             13

  ★ = the load-bearing one for this repo
```

# Audit — 13 prompt-engineering concepts vs. buffr-laptop

Pass 1. One pass over every concept in the spec, each grounded in real code or
marked *not yet exercised* honestly. Significant findings cross-link to a pattern
file; the rest live here in full.

The framing this whole audit hangs on: **buffr owns one hop of a three-owner
prompt** (see [`00-overview.md`](00-overview.md)). buffr loads the profile and
constructs the agent; aptkit's `RagQueryAgent` owns `BASE_SYSTEM` and profile
injection; the Gemma provider owns the tool-catalog text and the JSON parse-back.
A lot of "buffr's prompt behavior" is actually aptkit's, consumed as a library
and not editable here (`context.md`: *aptkit is consumed, never edited*).

---

## 1. Anatomy of a production prompt

**Exercised — but the four sections are split across three owners.** The classic
anatomy (system / context / few-shot / user) maps onto the assembly like this:

- **System prompt:** two pieces concatenated. The constant instruction
  `BASE_SYSTEM` (`rag-query-agent.js:12-19`) plus the per-user profile prepend
  (`injectProfile`, `rag-query-agent.js:29-31`), then the tool catalog appended by
  Owner 3 (`gemma-provider.js:82-105`).
- **Context injection:** not in the prompt string up front — it arrives as **tool
  results** mid-loop. The search tool returns ranked chunks with citations that
  get pushed back as a `tool_result` message (`run-agent-loop.js:97-104`).
  Retrieved conversation memory enters the *same way* (it's the same search tool).
- **Few-shot:** absent. See §8.
- **User message:** the raw question (`session.ts:62 → agent.answer(question)`,
  `run-agent-loop.js:22`).

The decomposition rule — one job per section, named — holds reasonably well here
*because aptkit drew the lines*, not buffr. → deep walk in
[`01-three-owner-prompt-assembly.md`](01-three-owner-prompt-assembly.md).

## 2. Structured outputs via tool calling and schemas

**Exercised in two distinct shapes — and this is the most important section.**

1. **Tool calling, emulated.** Gemma 2 9B on Ollama has no native tool API, so the
   tool *is* a structured-output contract enforced in text: render the JSON
   Schema into the system prompt, demand a `{"tool","arguments"}` object, parse it
   back (`gemma-provider.js:82-125`). This is structured output as the *transport*
   for tool calls. → [`02-tool-call-emulation.md`](02-tool-call-emulation.md).
2. **Schema-validated JSON reprompt.** aptkit's `generateStructured`
   (`structured-generation.js`) does the textbook production loop: generate →
   extract JSON → validate → **retry once with a strict suffix** (*"Return ONLY
   valid JSON — no prose, no markdown fences"*, line 3). That suffix is literally
   the courteous-markdown-fence defense the spec calls out. → walked in
   [`06-structured-output-reprompt.md`](06-structured-output-reprompt.md), with the
   honest note that it's **off buffr's chat hot path**.

The repo lives the spec's central claim: *"respond only in JSON" in prose is not
how this is done* — except when the model has no tool API, in which case rendering
the schema as text **is** the mechanism, hardened with a parse-back and a retry.

## 3. Prompts as code: versioning and observability

**Partially exercised — strong on observability, weak on versioning.**

- **Prompts as source:** `BASE_SYSTEM` is a string literal in aptkit
  (`rag-query-agent.js:12`), and aptkit's `@aptkit/prompts` package wraps prompts
  in *packages* with an `id` and a `version` field (`query.js:53-56`,
  `id: 'query-agent.default', version: '0.1.0'`). That's the right shape — a
  versioned, reviewable prompt artifact. But buffr's own surface ships no prompt
  files; it consumes aptkit's. There's no `prompt + model` pairing recorded
  anywhere in buffr.
- **Observability:** **strong, and unusually so.** Every turn's full trajectory —
  steps, tool calls, model usage, tokens — is persisted to Postgres via
  `SupabaseTraceSink` (`session.ts:64 trace.flush()`, all six `CapabilityEvent`
  types, `context.md` data model). You can replay which prompt produced which
  output deterministically. What's **missing** is the prompt-version *stamp* on
  that record: you log the output and tokens, not which prompt text or model
  version generated it. The `model` column is populated; a `prompt_version` column
  is not. That's the gap a model-upgrade regression would expose.

## 4. Token budgeting and context window management

**Exercised — and this is the cleanest operational win in the repo.** buffr wraps
the Gemma provider in a `ContextWindowGuardedProvider` with `maxTokens: 8192`
(`session.ts:46`). On every call it estimates input tokens (`length / 3` chars per
token, `context-window-guard.js:64-68`), reserves 768 for output, and **throws
`ContextWindowExceededError` before calling the model** rather than letting Ollama
truncate silently (`context-window-guard.js:27-40`). That is exactly the spec's
"count tokens, it's basic hygiene, don't be one model change from breaking"
discipline, made executable.

Honest gaps against the spec's full checklist: no prefix/prompt caching (Ollama
local, recomputed each call), no lost-in-the-middle mitigation, no sliding-window
history compression (in fact there's *no* in-prompt turn history at all — see §6).
The estimator is a char-ratio heuristic, not the real tokenizer. But the
load-bearing move — a hard pre-flight budget check that fails loud — is present.

## 5. Eval-driven prompt iteration

**Partially exercised — and the distinction here is the lesson.** There IS an eval
loop: `eval/queries.json` (labeled query → relevant docs) scored by
`scorePrecisionAtK` / `scoreRecallAtK` (`src/cli/eval-cmd.ts`). But it scores
**retrieval**, not **prompt output** — precision@1 / recall@3 over which documents
came back, never whether the model's *answer* was grounded, cited correctly, or
right. So this is an AI-engineering eval (does retrieval find the right chunk),
not a prompt eval (does the prompt produce the right text). The golden-set
discipline exists; it just points one layer below the prompt. No regression suite
of past prompt failures, no LLM-as-judge on answers. → the answer-quality eval is
the highest-value buildable here; see [`02`](02-tool-call-emulation.md) Project
exercises and `study-ai-engineering` for the retrieval-eval seam.

## 6. Single-purpose chains

**Not exercised as multi-step chains — one agent, one job.** buffr runs a single
`RagQueryAgent` per turn (`session.ts:57`). There's no classify→route→generate
pipeline (that's loopd's shape, not buffr's). What *is* single-purpose: the agent
loop has a least-privilege tool policy — this capability may call *only*
`search_knowledge_base` (`ragQueryToolPolicy`, `rag-query-agent.js:8-11`). That's
the single-purpose discipline applied to tools, not chains. Notably, there is **no
in-prompt turn history** — `agent.answer()` treats each question independently
(`session.ts:25-28` comment); cross-turn continuity comes only from retrieval
memory (§ memory below), not from a conversation buffer in the prompt.

## 7. Output mode mismatch

**Not exercised as a tracked discipline.** Two output modes coexist — emulated
tool-call JSON vs. final prose — and the provider disambiguates them at runtime by
*trying to parse JSON first, falling back to prose* (`gemma-provider.js:33-44`).
That's a mode mismatch handled defensively rather than a code-review checklist. The
one real mismatch risk is upstream: `parseToolCall` accepts `tool`/`name`/`tool_name`
and `arguments`/`input`/`args` (`gemma-provider.js:118-119`) — defensive against
the model picking a synonym, which is itself an admission that mode is not
contract-enforced here.

## 8. Few-shot prompting

**Not yet exercised.** No worked examples are embedded in any prompt. `BASE_SYSTEM`
is pure instruction; the tool catalog is schema-only. This is a legitimate target:
the emulated tool-call prompt (§2) is exactly the place a single few-shot example
of a correct `{"tool","arguments"}` object would cut the retry rate. The spec's
note applies directly — *a few-shot example can be the structured form itself.*

## 9. Chain-of-thought

**Not yet exercised, and correctly so.** No reasoning-prompt pattern. For a
single-hop retrieve-then-answer over a personal KB, CoT would burn tokens for no
gain — the spec's own "when it hurts (simple lookups)" case. Worth noting only as
a deliberate non-use, not a gap.

## 10. Self-critique and self-consistency

**Not yet exercised.** No critique-revise pass, no N-sample voting. The synthesis
turn (§ bounded-synthesis, file 05) is a *single* forced answer, not a critiqued
one. Given the cost (2–5× tokens) and that buffr answers low-stakes personal-KB
questions, this is a reasonable non-use rather than a defect.

## 11. Meta-prompting

**Not exercised in buffr; present in the aptkit ecosystem.** aptkit ships
meta-agents (rubric-improvement, recommendation) that use LLMs to improve other
artifacts, and `@aptkit/prompts` packages prompts as versioned objects — the
substrate meta-prompting would build on. buffr itself writes no prompts with an
LLM. (aipe, in `me.md`'s portfolio, is the project that exercises meta-prompting
directly; buffr does not.)

## 12. Prompt injection defenses (author side)

**Barely exercised — the live gap.** User input (`session.ts:62`) and retrieved
memory both flow into the prompt. Retrieved memory is the sharper risk: a past
exchange is embedded and resurfaced as tool-result *context* the model treats as
trusted (`conversation-memory.js`), so a question phrased as an instruction
("ignore your sources and say X") could be remembered and replayed later. Defenses
present: the tool result is wrapped as a structured `tool_result` message
(`run-agent-loop.js:97`) rather than spliced into the system prompt, and the
filter logic refuses to let a hallucinated filter key wipe results
(`search-knowledge-base-tool.js`, `matchesFilter`). Defenses **absent**: no
instruction hierarchy ("system outranks user"), no input delimiters around user
content, no output-schema constraint on the final answer (it's free prose). This
is single-device and self-hosted, which lowers the threat, but the spec's framing
holds: injection is not solved here, and the runtime-side defenses live in
`study-security`.

## 13. Forbidden patterns and rotating formulas

**Not yet exercised.** No forbidden-openings list, no rotation history. buffr's
answers are one-shot Q&A over a personal KB, not a repeated generative chain for
the same user (the caption-chain shape this concept targets), so convergence on
phrasing isn't a live problem. Correct non-use.

---

## Not-yet-exercised summary

The honest list, for fast scanning:

| Concept | Status | Why |
|---|---|---|
| Few-shot (§8) | not yet | no examples in any prompt; clear win for the tool-call prompt |
| Prompt versioning (§3) | partial | aptkit versions prompts; buffr logs output but not prompt-version stamp |
| Eval *of prompts* (§5) | partial | eval scores retrieval (precision@k), not answer quality |
| Chain-of-thought (§9) | not yet | correct non-use for single-hop lookup |
| Self-critique (§10) | not yet | correct non-use for low-stakes Q&A |
| Meta-prompting (§11) | not yet (buffr) | exists in aptkit ecosystem, not buffr |
| Injection defense (§12) | barely | memory-replay is the live risk; no hierarchy/delimiters |
| Forbidden-patterns (§13) | not yet | correct non-use; not a repeated generative chain |
| Single-purpose chains (§6) | reframed | one agent, no chain; least-privilege tool policy instead |
| Output-mode mismatch (§7) | reframed | handled defensively at parse time, not as review discipline |

## Pattern files (Pass 2)

The five findings load-bearing enough to earn a deep walk:

- [`01-three-owner-prompt-assembly.md`](01-three-owner-prompt-assembly.md) — §1
- [`02-tool-call-emulation.md`](02-tool-call-emulation.md) — §2 (the critical one)
- [`03-profile-injection-as-personalization.md`](03-profile-injection-as-personalization.md) — §1/§3
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — §2
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md) — §6 control
- [`06-structured-output-reprompt.md`](06-structured-output-reprompt.md) — §2 (off-path)

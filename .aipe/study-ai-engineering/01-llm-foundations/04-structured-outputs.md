# Structured Outputs

*Industry name: structured output / constrained decoding / function-call JSON. Type: **Industry standard.***

## Zoom out, then zoom in

Sometimes you need the model to return *data*, not prose — a typed object your code can branch on. Here's where that contract lives in buffr, and it's narrower than you'd expect.

```
buffr stack — the structured-output boundary
┌───────────────────────────────────────────────────────────┐
│ RagQueryAgent   wants a tool call back                      │
├───────────────────────────────────────────────────────────┤
│ buildSystemText   renders tool JSON schema into SYSTEM TEXT │ the "contract"
├───────────────────────────────────────────────────────────┤
│ gemma2:9b   emits text that SHOULD be {"tool":...}          │
├───────────────────────────────────────────────────────────┤
│ ★ parseAgentJson   text → JSON object (fenced / brace scan) │ THE PARSER
├───────────────────────────────────────────────────────────┤
│ parseToolCall   validates {name, input} shape, or null      │ the validator
└───────────────────────────────────────────────────────────┘
   (separate, unwired: RubricJudge → generateStructured + validator)
```

Here's the honest headline: **buffr uses no Zod and no JSON-mode in its own code.** The only structured-output path that actually runs is the *emulated tool-call JSON* — the model is asked, in plain English in the system prompt, to reply with a specific JSON shape, and buffr parses it out of the text afterward. There's a second, *unwired* path (the `RubricJudge`) that does it more rigorously. This file is about both, told straight.

## Structure pass — trace *trust* across the boundary

Pick one axis: **how much do you trust the model's output shape?** Watch trust drop to zero at the parse, then get rebuilt.

```
trust in the shape, request → use
  buildSystemText  │ "please reply as JSON"    │ HOPE (no enforcement)
  gemma2:9b output │ raw text, maybe JSON-ish  │ ZERO trust  ★ the seam
  parseAgentJson   │ extract a {...} substring │ trust = "it parsed"
  parseToolCall    │ check name+input exist    │ trust = "shape is right"
  agent uses it    │ dispatch the tool         │ trust earned
```

The seam is the model's output: you *asked* for JSON in English, but nothing *forced* it. There's no constrained decoding, no grammar, no JSON-mode. So trust is zero at the boundary and gets rebuilt by parsing and validating downstream. The whole reliability story is "ask nicely, then defensively parse." That's the ceiling of `gemma2:9b` — it has no native function-calling.

## How it works

### Move 1 — the mental model: types at a function boundary

You know this from TypeScript: a function says it returns `{name: string, input: object}`, and at runtime you sometimes still guard (`if (typeof x.name === 'string')`) because data from outside (an API, a form) can lie. Structured output is exactly that, except the "outside" is the model, and it lies *often* — so the runtime guard isn't optional, it's the whole mechanism.

```
the contract, frontend vs LLM
  TypeScript        │ compiler enforces shape   │ runtime guard = belt-and-braces
  LLM structured    │ NOTHING enforces shape    │ runtime guard = the ONLY enforcement
  ─────────────────────────────────────────────────────────────────────────────
  buffr lives in the bottom row: the parser IS the type system
```

### Move 2 — the moving parts

#### The contract is declared in English, in the system prompt

There's no `response_format: json` flag. The schema is *rendered as text* and the rule is *stated as a sentence*. From `buildSystemText` (`gemma-provider.ts:133–165`):

```ts
parts.push([
  'You can call the following tools:', '',
  rendered,                                    // ← each tool's input_schema, JSON.stringify'd
  '',
  'When a tool is needed, respond with ONLY a single JSON object, no prose:',
  '{"tool": "<tool name>", "arguments": { ...arguments... }}',   // ← the demanded shape
  'Otherwise, answer the user directly in natural language.',
].join('\n'));
```

Annotation that matters: this is the *entire* enforcement mechanism on the outbound side — a polite instruction. `gemma2:9b` can ignore it, wrap it in prose, add a markdown fence, or hallucinate a field. Everything after this is cleanup.

#### The parser scavenges JSON out of whatever came back

`parseAgentJson` (`packages/runtime/src/json-output.ts:7–28`) is two-stage: try a fenced ```` ```json ```` block, then a bounded `{`…`}` substring scan. It's built to forgive a model that wraps JSON in chatter:

```ts
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   // stage 1: fenced block
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }

  const start = /* first { or [ */;                            // stage 2: bounded scan
  const end   = /* last } or ] */;
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));        // ← carve JSON out of prose
  }
  throw new Error('no parseable json in model output');
}
```

```
parseAgentJson, two-stage scavenge
  raw: "Sure! ```json\n{\"tool\":\"search...\"}\n``` hope that helps"
        │
   stage 1: fenced block?  ──yes──▶ JSON.parse(inside fence)  ✓
        │ no
   stage 2: first{ … last} ───────▶ JSON.parse(carved substring)
        │ neither
        ▼  throw "no parseable json"
```

#### The validator turns parsed-JSON into a trusted shape — or `null`

`parseToolCall` (`gemma-provider.ts:168–182`) checks the object actually has a string `name` and an object `input` (tolerating aliases like `tool`/`name`/`tool_name`). If not, it returns `null`, and `complete()` treats the output as plain text instead:

```ts
const name  = obj.tool ?? obj.name ?? obj.tool_name;
const input = obj.arguments ?? obj.input ?? obj.args;
if (typeof name !== 'string') return null;                     // ← shape failed → not a tool call
if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
return { name, input: input as Record<string, unknown> };
```

#### The one retry: a single corrective nudge

If the output *looked* like a botched tool call (`looksLikeToolAttempt` = "contains a `{`"), `complete()` retries **once** with a `RETRY_NUDGE` appended (`gemma-provider.ts:35–37`, `:62–89`). One retry, then it gives up and returns the text as-is. That's the entire error-recovery budget for the structured path.

```
the retry budget
  attempt 1 ──parse fail & has '{'──▶ append RETRY_NUDGE ──▶ attempt 2 ──fail──▶ return as text
  (maxToolCallAttempts default 2 → exactly one retry)
```

### Move 2.5 — current vs future state (the rigorous path is unwired)

There's a *better* structured-output engine in the stack that buffr does not use: `generateStructured` (`packages/runtime/src/structured-generation.ts`) drives a typed validator with bounded retries, and `RubricJudge` (`packages/evals/src/rubric-judge.ts`) builds on it with a real `createRubricJudgmentValidator` that range-checks scores and rejects unknown verdicts. It's the closest thing to "Zod at the boundary" buffr has — and **nothing in buffr instantiates it.** The validator exists; no caller does.

```
two structured paths
  ACTIVE   │ tool-call JSON │ parseAgentJson + parseToolCall │ 1 retry  │ buffr USES
  UNWIRED  │ RubricJudge    │ generateStructured + validator │ 2 attempts│ buffr DOESN'T
                                  ▲ richer (range checks, typed result), but no caller
```

### Move 3 — the principle that generalizes

> **When the model can't be forced into a shape, the parser is your type system — and it must assume the model lied. Ask in plain language, parse defensively, validate explicitly, retry once, fall back gracefully.**

`gemma2:9b` has no native function-calling, so buffr can't lean on a provider's JSON-mode. The discipline that replaces it: never `JSON.parse` the raw output and trust it. Carve, validate, and have a fallback for when validation fails. The bug class this prevents is "the model added a sentence before the JSON and crashed my dispatcher."

## Primary diagram

The active structured-output path end to end, with the unwired one beside it.

```
structured output in buffr
  ACTIVE PATH (runs every agent turn)
  buildSystemText: "reply ONLY {"tool":...,"arguments":...}"  ← English contract
        │
  gemma2:9b → raw text (maybe JSON, maybe prose-wrapped)      ← ZERO enforcement
        │
  parseAgentJson  → fenced? brace-scan? → object | throw       ← scavenge
        │
  parseToolCall   → {name,input} | null                        ← validate
        │                    └─ null & had '{' → RETRY_NUDGE (once)
        ▼
  {type:'tool_use'}  → agent dispatches the tool

  UNWIRED PATH (exists, no caller)
  RubricJudge.judge → generateStructured → validator (range-checked) → RubricJudgment
```

## Elaborate

- **Origin.** OpenAI's function-calling (2023) made "model returns typed JSON" mainstream; later JSON-mode and constrained decoding (grammar-bound sampling) made it *reliable* by forcing the tokens. `gemma2:9b` predates none of this but *has* none of it — hence buffr's emulation, which is what everyone did before native support existed.
- **Adjacent concepts.** *Sampling* (03) — low temperature makes the model drift off-shape less. *Agents* (sub-section 04) — the consumer of the tool-call structured output. *Evals* (sub-section 05) — where the `RubricJudge` would finally get a caller.
- **Honest gap.** No Zod, no JSON-mode, no constrained decoding in buffr's own code. The active path is "render schema as text, parse it back" — adequate for one tool with two fields, fragile for anything richer. The rigorous path (`generateStructured`/`RubricJudge`) is built but unwired.
- **What to read next.** File 05 — streaming, which *conflicts* with structured output: you can't parse a JSON object until it's fully arrived.

## Project exercises

### Wire the RubricJudge as a generation eval

- **Exercise ID:** [B1.7] (Phase 1 — LLM foundations) — **the rigorous structured path is built but unwired.**
- **What to build:** Instantiate `RubricJudge` against `GemmaModelProvider`, define a small rubric (groundedness, citation-present), and score a handful of buffr's real RAG answers. This is buffr's first *validated* structured-output call — `generateStructured` + a typed validator, not the loose tool-call parse.
- **Why it earns its place:** Moves buffr from "ask nicely, parse loosely" to "validate against a typed contract with bounded retries." Also exposes the temperature problem from file 03 (the judge needs `temperature:0`, which the provider currently drops).
- **Files to touch:** new `src/cli/judge-cmd.ts`; reuse `src/session.ts` wiring for the model; read-only against the aptkit `RubricJudge`.
- **Done when:** running the judge on 3 answers prints validated `{dimensions, verdict, fix}` objects, and a malformed model reply triggers the strict-suffix retry.
- **Estimated effort:** 1–2 days

### Harden the tool-call parse with a logged failure rate

- **Exercise ID:** [B1.8] (Phase 1 — LLM foundations)
- **What to build:** Emit a trace warning whenever `parseToolCall` returns `null` after the retry, so you can measure how often `gemma2:9b` botches the JSON contract over a session.
- **Why it earns its place:** You can't trust the emulated path without knowing its real-world failure rate. Turns "it usually works" into a number.
- **Files to touch:** a buffr-side wrapping provider around `GemmaModelProvider` (aptkit is consumed); `src/supabase-trace-sink.ts` already persists `warning` events.
- **Done when:** a `tool-call-miss` warning lands in `agents.messages` each time the structured contract fails post-retry.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: "How does buffr get structured output from a model with no function-calling?"**

Model answer: It emulates it. `gemma2:9b` has no native tool-calling, so the tool schemas are rendered as text into the system prompt with a plain-English instruction to reply as `{"tool":...,"arguments":...}`. There's zero enforcement — the parser is the type system. `parseAgentJson` scavenges JSON out of the (possibly prose-wrapped) text via a fenced-block check then a brace-scan; `parseToolCall` validates the `{name, input}` shape or returns null. One corrective retry if it looked like a botched attempt, then fall back to treating the output as prose. There's a stricter path — `RubricJudge` over `generateStructured` with a real validator — but it's built and unwired. No Zod, no JSON-mode anywhere in buffr's own code.

```
the honest mechanism
  contract = English in system prompt   (no enforcement)
        ▼
  parse defensively  →  validate  →  retry once  →  fallback to text
  ★ the parser IS the type system
```

Anchor: *No native tool-calling — render the schema as text, then defensively parse it back.*

## See also

- `01-what-an-llm-is.md` — the `tool_use` content block this file manufactures.
- `03-sampling-parameters.md` — low temperature keeps the model on-shape.
- `05-streaming.md` — why streaming and structured output pull against each other.
- `../04-agents-and-tool-use/` — the agent loop that dispatches the parsed tool call.

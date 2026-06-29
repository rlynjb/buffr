# Structured Outputs

*Structured output / constrained generation — schema-as-contract — Industry standard.*

## Zoom out, then zoom in

Most of the time you want prose out of the model. Sometimes you want a *shape* — a JSON object you can `.parse()` and act on. buffr's most important structured output isn't a data record; it's the **tool call** itself: a `{tool, arguments}` object the model emits to invoke `search_knowledge_base`. Here's where that shape crosses the wire.

```
  Zoom out — where structured output lives in buffr

  ┌─ Agent layer (aptkit) ──────────────────────────────┐
  │  runAgentLoop: send tool schema → expect JSON back   │
  └──────────────────────────┬───────────────────────────┘
                             │  schema rendered into prompt (emulated)
  ┌─ Provider layer ─────────▼───────────────────────────┐
  │  ★ GemmaModelProvider ★                              │ ← the schema-as-contract seam
  │    buildSystemText: schema → prompt text             │
  │    parseToolCall:   model text → {tool, arguments}   │   NO validation of arguments
  └──────────────────────────┬───────────────────────────┘
                             │  parsed object
  ┌─ Tool layer ─────────────▼───────────────────────────┐
  │  search_knowledge_base handler(args) → pgvector      │
  │    args.query ?? '' → wrong key = EMPTY search       │
  └──────────────────────────────────────────────────────┘
```

Zoom in: a structured-output contract has two halves — a *schema* you send ("here's the shape I want") and *validation* you run on what comes back ("does it match?"). buffr's tool boundary has the first half and **skips the second**. The `search_knowledge_base` `inputSchema` declares `required: ['query']`, but nothing ever checks that the model actually produced a `query` key. That missing check is buffr's reliability ceiling — and it's why this file cross-links hard to `../04-agents-and-tool-use/02-tool-calling.md`.

## Structure pass

Two places in the stack produce structured output. Trace the axis **is the output validated against its schema?** — and watch it flip.

```
  Axis: "is the structured output validated?" — two surfaces, opposite answers

  ┌─ buffr tool boundary (the hot path) ─────┐
  │  search_knowledge_base inputSchema        │  schema = DECLARED
  │  parseToolCall returns input AS-IS        │  validation = NONE  ✗
  └─────────────────────┬─────────────────────┘
                        │  seam: same provider interface, different caller
  ┌─ aptkit RubricJudge (eval path) ─▼────────┐
  │  generateStructured(validate: …)          │  schema = DECLARED
  │  createRubricJudgmentValidator rejects bad │  validation = ENFORCED ✔
  └───────────────────────────────────────────┘
```

Same model, same JSON-out idea, opposite rigor. On the tool boundary, a malformed `{...}` flows straight into the handler — a wrong key just yields an empty search, silently. In the judge, a malformed object is *rejected* and re-asked, because `generateStructured` runs a validator. The seam is the caller's choice to validate or not. The lesson of this file is the cost of *not* validating: buffr's reliability ceiling lives exactly at the unvalidated seam.

## How it works

#### Move 1 — the mental model

You know how a form `<input required>` declares intent but you still write a JS validator because the browser's check isn't enough? Structured output is the same two-part deal: a schema declares the shape, a validator enforces it. The strategy: **declare the schema as a contract, then verify the model honored it before you trust the result.** buffr declares but doesn't verify at the tool boundary.

```
  Pattern — schema-as-contract, the two halves

  ┌─ half 1: DECLARE ─────────────┐     ┌─ half 2: VALIDATE ────────────┐
  │ inputSchema {                  │     │ parse model output             │
  │   properties: { query: str },  │ ──► │ does it match the schema?      │
  │   required: ['query']          │     │   yes → use it                 │
  │ }                              │     │   no  → reject / re-ask        │
  └────────────────────────────────┘     └────────────────────────────────┘
        buffr HAS this                    buffr SKIPS this at the tool seam
                                          (RubricJudge does NOT skip it)
```

#### Move 2 — the step-by-step walkthrough

**The schema buffr declares.** The `search_knowledge_base` tool defines a proper JSON Schema, including a `required` array. This is half 1, done correctly.

```
  createSearchKnowledgeBaseTool — search-knowledge-base-tool.ts:58-75 (annotated)

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The natural-language search query.' },
      top_k: { type: 'integer', default: 5 },
      filter: { type: 'object', additionalProperties: true },
    },
    required: ['query'],            // ← the CONTRACT: a query is mandatory
    additionalProperties: false,
  }
```

`required: ['query']` says: every valid call must carry a `query`. That's a real contract. The question is whether anyone enforces it.

**Where the contract is rendered to the model.** Gemma has no native tool API, so aptkit serializes the schema into the system prompt as text and asks for JSON back. This is the "declare" half reaching the model.

```
  buildSystemText — gemma-provider.ts:137-161 (annotated)

  const rendered = request.tools.map((tool) =>
    JSON.stringify({ name: tool.name, ..., input_schema: tool.inputSchema }, null, 2)
  ).join('\n\n');
  parts.push([
    'You can call the following tools:', '', rendered, '',
    'When a tool is needed, respond with ONLY a single JSON object, no prose:',
    '{"tool": "<tool name>", "arguments": { ...arguments... }}',  // ← the requested shape
  ].join('\n'));
```

The full `inputSchema` — including `required: ['query']` — is pasted into the prompt. So the model *sees* the contract. Whether it *honors* it is up to the model, and nothing downstream checks.

**Where validation is skipped — the reliability ceiling.** `parseToolCall` turns the model's text back into an object and returns the arguments **exactly as the model wrote them**. It checks that `arguments` is an object — and nothing more.

```
  parseToolCall — gemma-provider.ts:168-182 (annotated)

  const name  = obj.tool ?? obj.name ?? obj.tool_name;
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };   // ← input passed AS-IS
                                                               //   NO check for `query`
```

There is no check that `input.query` exists or is a string. The schema said `required: ['query']`, but this code never reads the schema. So if the model emits `{"tool":"search_knowledge_base","arguments":{"q":"cats"}}` — wrong key `q` instead of `query` — it sails through.

**What the wrong key costs.** The handler coalesces a missing `query` to empty string, which means an *empty search*: the most relevant chunks for `""` — i.e. garbage — and the answer is ungrounded.

```
  Layers-and-hops — a wrong key becomes an empty search, silently

  ┌─ model ──────┐  {"arguments":{"q":"cats"}}   ┌─ parseToolCall ──┐
  │ gemma2:9b    │ ──── wrong key, no `query` ───►│ returns AS-IS    │ no reject
  └──────────────┘                                └────────┬─────────┘
                                                           │ input={q:"cats"}
                                                           ▼
  ┌─ handler — search-knowledge-base-tool.ts:79 ───────────────────────┐
  │  const query = typeof args.query === 'string' ? args.query : '';   │
  │                          ↑ args.query is undefined → query = ''     │
  └────────────────────────────┬───────────────────────────────────────┘
                               ▼
                    pgvector search for ""  → irrelevant chunks → bad answer
```

This is *the* reliability ceiling: no exception, no retry, just a quietly empty result. Contrast the retry path that *does* exist — Gemma retries when the JSON is *unparseable* (`looksLikeToolAttempt`, `gemma-provider.ts:86`), but a well-formed object with the *wrong keys* parses fine and is never caught.

**The contrast: where validation IS enforced.** aptkit's `RubricJudge` uses `generateStructured` with a real validator. It's not in buffr's hot path, but it shows the pattern done right.

```
  RubricJudge.judge — rubric-judge.ts:93-104 (annotated)

  return generateStructured({
    ...,
    validate: createRubricJudgmentValidator(this.rubric),  // ← half 2, present
  });

  // the validator (rubric-judge.ts:185-205) rejects bad shapes:
  if (typeof score.score !== 'number') return { ok: false, error: '... must be a number' };
  if (!verdicts.has(value.verdict))    return { ok: false, error: '... not allowed' };
```

`generateStructured` re-asks the model when `validate` returns `ok:false`. A malformed judgment never reaches the caller. That's the half buffr's tool boundary is missing — and the gap is closeable on the buffr side by validating `input` against `tool.definition.inputSchema` before dispatch.

#### Move 3 — the principle

A schema is only a contract if something enforces it. Declaring `required: ['query']` and then passing the model's output through unchecked gives you the *appearance* of a contract with none of the safety: malformed output degrades silently instead of failing loudly. The fix is universal — validate structured output against its schema at the boundary, and re-ask or error on mismatch. buffr does this for the judge (`generateStructured`) and not for the tool call, and that single asymmetry is where its reliability ceiling sits.

## Primary diagram

```
  Structured output in buffr — declared everywhere, validated only on the eval path

  ┌─ DECLARE (half 1) ──────────────────────────────────────────────┐
  │  search_knowledge_base inputSchema, required:['query']          │
  │     [search-knowledge-base-tool.ts:58]                          │
  │  rendered into prompt by buildSystemText [gemma:137]            │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ model emits {tool, arguments}
            ┌─────────────────────┴─────────────────────┐
            ▼  TOOL PATH (hot)                           ▼  EVAL PATH
  ┌─ parseToolCall [gemma:168] ──────────┐   ┌─ generateStructured [rubric:93] ─┐
  │  returns input AS-IS — NO validate ✗ │   │  validate: validator — re-asks ✔ │
  └──────────────┬────────────────────────┘   └──────────────┬───────────────────┘
                 │ wrong key → query='' [tool:79]            │ bad shape → rejected
                 ▼                                            ▼
        empty search → bad answer                    only valid judgments pass
        (THE reliability ceiling)
```

## Elaborate

Structured output started as "ask the model for JSON and hope," matured into *constrained decoding* (grammar/JSON-schema-constrained sampling, where the model literally cannot emit an invalid token) and *function calling* (native tool APIs that guarantee a parseable shape). Gemma2 via Ollama has neither native function calling nor constrained decoding in buffr's setup, so aptkit *emulates* it: render-the-schema-into-the-prompt and parse-back. Emulation gets you the shape most of the time but guarantees nothing — which is precisely why the missing validation hurts.

The connection to adjacent files is tight. `03-sampling-parameters.md`: a low temperature raises the odds the model emits the schema correctly, partially mitigating the missing validation. `08-provider-abstraction.md`: the emulation lives in the provider, so the fix is a provider-or-boundary concern. `../04-agents-and-tool-use/02-tool-calling.md`: that file walks the same seam from the agent's side — read both together; this one is the "schema contract" view, that one is the "tool dispatch" view.

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **exercised but emulated and unvalidated** — Case A for the declared schema, Case B for the missing enforcement.

### EX-04-1 — Validate tool arguments against the inputSchema before dispatch

- **Exercise ID:** EX-04-1
- **What to build:** A thin validation step in buffr's tool wiring that checks the model's parsed `arguments` against `tool.definition.inputSchema` (at minimum, that every `required` key is present and typed) before the handler runs — turning a silent empty search into a caught, loggable error (or a re-ask).
- **Why it earns its place:** Closes buffr's named reliability ceiling. This is the single highest-value robustness fix in the foundations section.
- **Files to touch:** `src/session.ts:43-44` (wrap the tool handler / registry), optionally a new `src/validate-tool-args.ts`. Do not edit aptkit — wrap on buffr's side.
- **Done when:** a tool call with a wrong key (e.g. `{q:"x"}`) produces a logged validation error / `warning` trace instead of a silent empty-string search, proven by a test.
- **Estimated effort:** 1-2 days

### EX-04-2 — Trace structured-output failures as warnings

- **Exercise ID:** EX-04-2
- **What to build:** When validation (from EX-04-1) fails, emit a `warning` capability event so it lands in `agents.messages` via the existing sink — making "the model produced the wrong shape" visible in the trajectory instead of invisible.
- **Why it earns its place:** Pairs enforcement with observability; you can't fix what you can't see, and `SupabaseTraceSink` already persists `warning` events.
- **Files to touch:** the validation wrap from EX-04-1; `src/supabase-trace-sink.ts:80-83` (already handles `warning`/`error` — confirm the path).
- **Done when:** a wrong-key call writes a `warning` row to `agents.messages`.
- **Estimated effort:** <1hr

## Interview defense

**Q: "buffr's tool has `required:['query']` in its schema. What enforces it?"**

Nothing, on the hot path. The schema is rendered into the prompt so the model sees it, but `parseToolCall` returns the model's arguments as-is — it never validates against the schema. A wrong key passes through and the handler coalesces the missing `query` to `''`, so you get an empty search and an ungrounded answer with no error.

```
  declared ≠ enforced

  required:['query']  ──► (no check) ──► {q:"cats"} ──► query='' ──► bad answer
```

*Anchor:* `parseToolCall` returns input as-is at `gemma-provider.ts:168-182`; the empty-string coalesce is `search-knowledge-base-tool.ts:79`.

**Q: "Does buffr ever validate structured output? Why the difference?"**

Yes — the `RubricJudge` uses `generateStructured` with a validator that rejects and re-asks on a bad shape. The difference is the caller's choice: the eval path validates because a wrong score is a wrong result; the tool path doesn't, which is exactly the gap to close.

```
  two surfaces, one decision

  tool call ──► parseToolCall ──► no validate   ✗
  judge     ──► generateStructured(validate) ──► reject + re-ask ✔
```

*Anchor:* `rubric-judge.ts:93-104` (validated) vs `gemma-provider.ts:168` (not).

## See also

- `../04-agents-and-tool-use/02-tool-calling.md` — the same seam from the agent/dispatch side (read together).
- `08-provider-abstraction.md` — where the tool-call emulation lives and why.
- `03-sampling-parameters.md` — low temperature improves schema-conformance odds.
- `../05-evals-and-observability/02-eval-methods.md` — the validated `RubricJudge` in context.

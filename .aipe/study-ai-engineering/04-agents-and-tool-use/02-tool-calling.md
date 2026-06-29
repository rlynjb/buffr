# Tool calling — and the Gemma emulation seam

*Industry standard pattern; project-specific reliability ceiling.*

## Zoom out, then zoom in

This is the most important file in the agents section, because it's where buffr's reliability ceiling lives. Pull up the layer where the model's text becomes an action.

```
  Zoom out — where the tool-call contract lives

  ┌─ Agent loop ────────────────────────────────────────────────┐
  │  runAgentLoop — needs a tool-call out of the model           │
  └───────────────────────────┬─────────────────────────────────┘
                              │  model.complete(system + tool schema)
  ┌─ Model provider ──────────▼─────────────────────────────────┐
  │  ★ GemmaModelProvider — NO native tools → EMULATES them ★    │ ← we are here
  │   render schema into prompt · parse JSON back out of text    │
  └───────────────────────────┬─────────────────────────────────┘
                              │  { name, input } (unvalidated)
  ┌─ Tool registry ───────────▼─────────────────────────────────┐
  │  InMemoryToolRegistry.callTool(name, args) — runs handler    │
  └─────────────────────────────────────────────────────────────┘
```

The verdict up front: buffr's tool-calling works, but on a model that has **no native tool-calling API**. aptkit fakes it — renders the JSON schema into the prompt, then parses a JSON object back out of the model's free text. And critically: **there is no argument-schema validation on the way back.** That single missing check is the ceiling on how reliable buffr can be.

## Structure pass

**Layers:** loop (wants an action) → provider (emulates the tool protocol) → registry (dispatches to the handler).

**Axis — "trust: what's validated at this boundary?"**

```
  trace "what is validated?" across the tool-call seam

  ┌─ loop ──────────┐  seam   ┌─ provider ──────┐  seam   ┌─ registry ─────┐
  │ tool NAME must  │ ═══════►│ JSON parsed     │ ═══════►│ args passed    │
  │ match registry  │ (checked)│ name extracted  │ (NOT    │ straight to    │
  │                 │         │ args extracted   │ checked)│ handler        │
  └─────────────────┘         └─────────────────┘         └────────────────┘
        validated                   shape-checked              UNVALIDATED args

  the trust answer FLIPS: name is checked, arguments are not
```

That flip is the whole story. The tool *name* is validated (`callTool` throws "tool not found" on a bad name — `tool-registry.ts:57`). The *arguments* are not. A structurally-valid JSON with the wrong keys sails through.

## How it works

### Move 1 — the mental model

A native tool-call API (Anthropic, OpenAI) is like a typed function signature the provider enforces — you declare the schema, and the model's tool-call comes back conforming to it or the API errors. Gemma has no such API. aptkit's emulation is like passing a function's *documentation* as a string and asking the model to "please reply with JSON shaped like this," then `JSON.parse`-ing whatever it says. It usually works. It is not enforced.

```
  native tool-call           emulated tool-call (buffr/Gemma)
  ────────────────           ───────────────────────────────
  schema enforced by         schema = text in the prompt
  the provider               │
  │                          ▼  model replies with free text
  ▼                          {"tool":"search_knowledge_base",
  conforming tool-call        "arguments":{"query":"..."}}
  (or API error)             │
                             ▼  parseAgentJson + parseToolCall
                             {name, input}  ← NO validation
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the tool schema is rendered into the system prompt.** aptkit serializes each tool — name, description, `input_schema` — as JSON and tells the model the exact reply format.

```ts
// aptkit packages/providers/gemma/src/gemma-provider.ts:137-162 (buildSystemText, condensed)
const rendered = request.tools.map((tool) => JSON.stringify({
  name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema,
}, null, 2)).join('\n\n');
parts.push([
  'You can call the following tools:', '', rendered, '',
  'When a tool is needed, respond with ONLY a single JSON object, no prose:',
  '{"tool": "<tool name>", "arguments": { ...arguments... }}',
  'Otherwise, answer the user directly in natural language.',
].join('\n'));
```

So the model *sees* the schema — including that the search tool requires `query` (`search-knowledge-base-tool.ts:53-76` declares `required: ['query']`). But "sees" is not "is bound by."

**Step 2 — the model's text reply is parsed back into a tool-call.** This is the inbound half of the emulation. `parseToolCall` runs `parseAgentJson` (a fenced-or-bounded-substring JSON scan) and extracts name + input, accepting several key aliases.

```ts
// aptkit packages/providers/gemma/src/gemma-provider.ts:168-182 (parseToolCall)
function parseToolCall(text: string) {
  let parsed; try { parsed = parseAgentJson(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name  = obj.tool ?? obj.name ?? obj.tool_name;      // name aliases tolerated
  const input = obj.arguments ?? obj.input ?? obj.args;     // arg-object aliases tolerated
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };  // ← input returned AS-IS
}
```

Read the last line carefully. The `input` object is returned **as-is**. There's no check that `input.query` exists, no check against the declared `input_schema`. The emulation validates the *envelope* (is it an object with a string name and an object input?) and nothing about the *contents*.

**Step 3 — the registry dispatches without validating args.** `InMemoryToolRegistry.callTool` looks up the handler by name and calls it with the raw args.

```ts
// aptkit packages/tools/src/tool-registry.ts:50-63 (callTool)
async callTool(name, args, options?) {
  const handler = this.handlers.get(name);
  if (!handler) throw new Error(`tool not found: ${name}`);   // ← name IS checked
  const start = performance.now();
  const result = await handler(args, options);                // ← args NOT checked
  return { result, durationMs: Math.round(performance.now() - start) };
}
```

**Step 4 — the handler defensively coerces a missing arg to empty.** And here's where the failure becomes silent. The search tool's handler reads `args.query`, and if it isn't a string, uses `''`.

```ts
// aptkit packages/retrieval/src/search-knowledge-base-tool.ts:78-82 (handler)
const query = typeof args.query === 'string' ? args.query : '';   // ← wrong key → ''
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);                    // buffr sets minTopK: 4
let hits = await pipeline.query(query, fetchK);                   // search over ''
```

Now trace the consequence concretely: the model emits `{"tool":"search_knowledge_base","arguments":{"q":"how do I take coffee"}}`. `parseToolCall` returns `{name:"search_knowledge_base", input:{q:"..."}}`. `callTool` finds the handler (name is valid) and calls it. The handler reads `args.query` → undefined → `''`. `pipeline.query('', 4)` embeds the empty string and returns whatever four chunks are nearest to the embedding of nothing. The trace shows a clean `tool_call_start` / `tool_call_end`, the loop continues, and the model answers from garbage. **No error anywhere.** That's the ceiling.

```
  the failure trace — every layer reports success

  model: {"arguments":{"q":"..."}}   ← wrong key (model's mistake)
    │ parseToolCall → {input:{q:"..."}}        ✓ valid envelope
    │ callTool("search_knowledge_base", {q})   ✓ name found
    │ handler: args.query → undefined → ''      ✓ no throw
    │ pipeline.query('', 4)                     ✓ returns 4 chunks
    ▼
  answer grounded in noise   ← the ONLY symptom, and it's invisible to the trace
```

### Move 2 variant — the load-bearing skeleton

The kernel of emulated tool-calling: **render schema as prompt text → parse JSON from reply → dispatch by name.** What's missing that breaks reliability: **validate the parsed args against the schema before dispatch.**

- Without the render step → the model doesn't know the tool exists.
- Without the parse step → you can't turn text into an action.
- Without **arg validation** → wrong keys become empty searches silently. This is the part buffr inherits as a gap; aptkit is consumed, not edited, so the fix is a buffr-side wrapper.

### Move 2.5 — current state vs future state

```
  Phase A (today)                    Phase B (the fix, buffr-side wrapper)
  ─────────────                      ────────────────────────────────────
  parse {name, input}                parse {name, input}
  dispatch input as-is               validate input vs inputSchema
  wrong key → '' → empty search      wrong key → throw → loop retries with
  silent garbage answer                the error as an observation
```

The migration cost is small and lives entirely in buffr: wrap `createSearchKnowledgeBaseTool`'s handler (or the registry) to assert `required` keys are present before calling `pipeline.query`, and on a miss, return a tool *error* so the loop's error-recovery (`06-error-recovery.md`) re-prompts. What doesn't change: the agent loop, the provider, the schema. You only add a gate.

### Move 3 — the principle

The model is the brain, the tool is the hands — but on an emulated provider, the wire between them is untyped. Any time you call tools on a model without a native tool API, *you* own the validation the provider would otherwise do. Skipping it doesn't fail loudly; it fails as quietly degraded retrieval, which is the worst kind of bug because no exception ever fires.

## Primary diagram

```
  buffr tool-calling — full path with the missing gate marked

  loop ─► model.complete(system + rendered schema, tools)
            │
            ▼  free text
        parseAgentJson → parseToolCall → {name, input}
            │                                 │
       name checked ✓                    input UNCHECKED ✗  ◄── the gap
            ▼
        callTool(name, input)
            ▼
        handler: query = args.query ?? ''   ◄── coerces miss to empty
            ▼
        pipeline.query(query, max(top_k, minTopK=4))
            ▼
        ranked chunks ─► back to loop as observation
```

## Elaborate

Native tool-calling (function calling) was introduced precisely to kill this class of bug — the provider constrains the output to the schema. buffr can't use it because Gemma via Ollama doesn't expose one, so aptkit reconstructs the protocol in user space. This is a completely standard pattern for open local models, and it's a great thing to have built — but the honest framing is that emulation moves the validation burden onto the application, and buffr hasn't picked it up yet. The structured-output discipline (`../01-llm-foundations/04-structured-outputs.md`) is the same lesson from the output side.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Validate tool args before dispatch

- **Exercise ID:** TOOL-1 (Case B — validation not yet exercised). **The highest-leverage exercise in this guide.**
- **What to build:** a buffr-side wrapper around the search tool handler that checks `inputSchema.required` keys are present and correctly typed; on a miss, return a tool error instead of searching `''`.
- **Why it earns its place:** turns a silent reliability ceiling into a loud, recoverable error — exactly the "I found and fixed my agent's quiet failure mode" story interviewers want.
- **Files to touch:** `src/session.ts:43-44` (wrap `tool.handler` before registering), or a new `src/validated-tool.ts`.
- **Done when:** a forced wrong-key tool-call produces a tool error in the trace and a loop retry, verified by a test.
- **Estimated effort:** 1–4hr.

### Log emulation parse failures

- **Exercise ID:** TOOL-2 (Case A — observability of the emulation).
- **What to build:** persist a `warning` trace event whenever `parseToolCall` returns null mid-loop (the model emitted prose where a tool-call was expected) so you can measure emulation reliability.
- **Why it earns its place:** quantifies how often Gemma's emulation actually misfires — a number you can put on a slide.
- **Files to touch:** `src/supabase-trace-sink.ts` (already handles `warning` events — surface them), and a count in `eval` tooling.
- **Done when:** the eval run reports an emulation-miss rate.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: How does buffr call tools if Gemma has no tool API?**
Answer: aptkit emulates it — renders the tool's JSON schema into the system prompt, instructs the model to reply with a single JSON object, then parses that object back out of the free text with `parseToolCall`. It's the standard pattern for local models without function-calling.

**Q: What's the reliability ceiling, and how would you raise it?**
Answer: there's no argument-schema validation. The tool *name* is checked, but the arguments are passed straight to the handler, which coerces a missing `query` to the empty string — so a wrong key (`q` vs `query`) becomes a search over `''` with no error anywhere. **The load-bearing part everyone forgets is validating the parsed args against the schema before dispatch.** The fix is a buffr-side handler wrapper that throws on missing required keys, turning a silent failure into a recoverable tool error.

```
  the one-liner:  name validated ✓  ·  args validated ✗  →  wrong key = empty search, silently
```

## See also

- `01-agents-vs-chains.md` — the loop that runs this contract.
- `06-error-recovery.md` — where a validated tool-error would be recovered.
- `../01-llm-foundations/04-structured-outputs.md` — the same validation lesson, output side.
- `../05-evals-and-observability/04-llm-observability.md` — why the trace doesn't catch this today.

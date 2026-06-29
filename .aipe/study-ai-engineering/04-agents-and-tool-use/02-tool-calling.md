# Tool Calling — the Emulated JSON Path
### *Schemas into the prompt, JSON back out, and the validation that isn't there*
**Type label:** model–tool interface (structured output)

## Zoom out

Look at where tool calling sits. It's not the loop and it's not the tool — it's the *translation layer* between them, the thing that turns "the model wants to search" into "a function got called with arguments."

```
The translation layers around a tool call
┌────────────────────────────────────────────────────────────┐
│  Agent loop      runAgentLoop — wants the model to act        │  control
├────────────────────────────────────────────────────────────┤
│  ★ TOOL CALLING  GemmaModelProvider — schemas↔JSON translate  │  ← this file
│                  outbound: schemas→prompt                     │
│                  inbound:  text→parsed call                   │
├────────────────────────────────────────────────────────────┤
│  Tool registry   callTool(name, input) → search_knowledge_base│  execution
└────────────────────────────────────────────────────────────┘
```

The agent loop above speaks in `tool_use` blocks (`{name, input}`). The tool registry below speaks in function calls. Neither knows the model can't do tool calling natively. The ★ layer hides that — and *how* it hides it is the most consequential design fact in buffr.

Conversational version. With a frontier model (Claude, OpenAI), tool calling is a *protocol*: you send a `tools` array, the API returns a typed, schema-*validated* tool-call object. The provider guarantees the arguments match the schema. `gemma2:9b` has none of that. It's a chat model that emits text. So buffr *emulates* the protocol: it writes the tool schemas into the system prompt as JSON, asks the model to please reply with a JSON object, and then hand-parses whatever comes back. It works. It also has a hole, and the hole is the whole story.

## Structure pass

The one axis here: **native validation vs emulated trust.** On the native path, the provider validates arguments against the schema before you ever see the call. On the emulated path, *nobody does* — the parsed object goes straight to the tool.

```
The validation axis (where buffr sits on the dangerous end)
   VALIDATED                                        TRUSTED-AS-IS
   (provider checks args)                           (parse and pass)
   ├─────────────────────────────────────────────────────────────┤
   Claude / OpenAI                                  gemma2:9b (buffr)
   schema-checked tool call                         JSON parsed, NOT checked
                                                              ▲
                                                              │
                                                    THE RELIABILITY CEILING
```

The seam where the protocol flips from native to emulated is `GemmaModelProvider.complete`. Above it, the loop thinks it's getting a validated `tool_use` block. Below it, the provider is doing string surgery on chat text. The flip is invisible to the loop — which is exactly why the missing validation is easy to miss.

## How it works

### Move 1 — the mental model

Tool calling, emulated, is a round trip through text. Schemas go out as prompt; a call comes back as a JSON object you dig out of prose.

```
The round trip
  OUTBOUND                         INBOUND
  tool schemas                     model's raw text
     │ buildSystemText                │ parseAgentJson
     ▼                                ▼
  JSON in system prompt            { "tool": "...", "arguments": {...} }
     │                                │ parseToolCall
     ▼                                ▼
  "reply with ONLY a JSON object"  tool_use block → callTool
```

The model never sees a `tools` parameter. It sees instructions in English and JSON in its system text, and it's *asked* to cooperate. Whether it does is probabilistic.

### Move 2 — step by step

#### Outbound: schemas rendered into the system prompt (`buildSystemText`)

Bridge from what you know: this is server-side rendering of a form. You have a JSON schema; you render it into the page (here, the prompt) as text, with instructions on how to fill it. The model is the user filling the form, and like any HTML form, nothing stops the user from submitting garbage.

```
Outbound: each tool → JSON block in the system text
  request.tools = [search_knowledge_base]
     │  JSON.stringify({name, description, input_schema})
     ▼
  system prompt += 
    "You can call the following tools:
     { "name": "search_knowledge_base",
       "input_schema": { ... required: ["query"] ... } }
     When a tool is needed, respond with ONLY a single JSON object:
     {"tool": "<tool name>", "arguments": { ...arguments... }}"
```

Real code, `aptkit packages/providers/gemma/src/gemma-provider.ts:133`:

```ts
function buildSystemText(request: ModelRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);

  if (request.tools?.length) {
    const rendered = request.tools
      .map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description ?? '',
          input_schema: tool.inputSchema,        // ← the schema goes IN as text...
        }, null, 2),
      )
      .join('\n\n');
    parts.push([
      'You can call the following tools:', '', rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',
      'Otherwise, answer the user directly in natural language.',
    ].join('\n'));
  }
  return parts.join('\n\n');
}
```

The consequence: the schema is *advisory*. It's a description in the prompt, not a contract the runtime enforces. The model reads `required: ["query"]` as a suggestion. That's the setup for the hole; hold it.

#### Inbound: hand-parsing the model's text (`parseToolCall` → `parseAgentJson`)

Bridge: you've done this. A `fetch()` that returns text you have to `JSON.parse`, except the server sometimes wraps it in a code fence or pads it with prose, so you scan for the braces. That's exactly `parseAgentJson` — a forgiving parser for an unreliable producer.

```
Inbound: dig a JSON object out of messy text
  raw model text
     │ parseAgentJson
     ├─ try: fenced ```json ... ``` block?  → JSON.parse
     ├─ else: bounded { ... } substring scan → JSON.parse
     └─ else: throw "no parseable json"
     ▼
  parseToolCall: name = tool | name | tool_name
                 input = arguments | input | args
     ▼  (name is string? input is object?)
  { name, input }    ← or null (not a tool call → treat raw as prose)
```

Real code, the parser, `aptkit packages/runtime/src/json-output.ts:7`:

```ts
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }

  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no parseable json in model output');
}
```

And the call extraction, `aptkit packages/providers/gemma/src/gemma-provider.ts:168`:

```ts
function parseToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  let parsed: unknown;
  try { parsed = parseAgentJson(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name = obj.tool ?? obj.name ?? obj.tool_name;     // ← lenient: 3 spellings for the name
  const input = obj.arguments ?? obj.input ?? obj.args;   // ← lenient: 3 spellings for the args
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input: input as Record<string, unknown> };   // ← input passed through UNCHECKED
}
```

Read that last line slowly. `input` is checked to be *an object*. It is **never** checked against `input_schema`. Whatever keys the object has, that's what `callTool` gets.

#### The one retry: a single corrective nudge (`RETRY_NUDGE`)

Bridge: an optimistic retry with a hint, like re-fetching once with a corrected header. One shot, not a loop.

```
The retry budget (one nudge, then give up)
  attempt 0:  complete(baseMessages)
     │  parseToolCall → call?  → return it
     │  no call, but looksLikeToolAttempt (text contains '{')?
     ▼  yes → attempt 1
  attempt 1:  complete(baseMessages + RETRY_NUDGE)
     │  parseToolCall → call?  → return it
     ▼  still no → fall through, treat raw text as the answer (prose)
```

Real code, `aptkit packages/providers/gemma/src/gemma-provider.ts:62`:

```ts
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const messages = attempt === 0
    ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];   // ← corrective hint on retry
  lastResponse = await this.chat({ model: this.defaultModel, messages, stream: false, ... });
  raw = lastResponse.message?.content ?? '';

  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);
    if (looksLikeToolAttempt(raw)) continue;   // ← only retry if it LOOKED like a botched call
  }
  break;
}
return this.toResponse([{ type: 'text', text: raw }], lastResponse);   // ← give up → prose
```

`maxToolCallAttempts` defaults to 2, so there is exactly *one* retry. The `looksLikeToolAttempt` check (does the text contain a `{`?) is a cheap heuristic: if the model wrote prose with no brace, that's a real answer, don't retry. If it wrote a malformed `{`, nudge once. After that, malformed JSON becomes the user's "answer" — prose where a tool call should have been.

### Move 2.5 — current vs future

```
Where validation could live (current ✗ / future ✓)
  parseToolCall returns { name, input }
     │
  ✗ current:  input → callTool                  (no check)
  ✓ future:   input → validate(input, schema)?  (Ajv / hand-rolled)
                 │ ok    → callTool
                 └ fail  → RETRY_NUDGE with the specific error, OR reject
```

Today the parsed call goes straight to `callTool`. The natural place to close the hole is *between* `parseToolCall` and the returned `tool_use` block: validate `input` against `input_schema`, and on failure either reject (so the model retries) or pass the schema error back as the nudge. Native providers do this for free. The emulated path has to do it by hand, and currently doesn't.

### Move 3 — the principle: THE RELIABILITY CEILING

State it without hedging: **the emulated tool-calling path performs no argument-schema validation, and that is the hard ceiling on buffr's reliability.**

Here is the concrete failure. The search tool's schema declares `required: ["query"]`. Suppose `gemma2:9b` emits `{"tool":"search_knowledge_base","arguments":{"q":"my notes on X"}}` — the right *idea*, the wrong *key* (`q` not `query`). `parseToolCall` sees a string name and an object input, returns it as valid. `callTool` invokes the handler. The handler, `aptkit packages/retrieval/src/search-knowledge-base-tool.ts:79`, does:

```ts
const query = typeof args.query === 'string' ? args.query : '';   // ← args.query is undefined → ''
```

So `query` becomes the **empty string**. The pipeline embeds `''`, pgvector returns whatever the empty-string vector is nearest to — noise, top-of-corpus, garbage — and the model synthesizes an answer over irrelevant chunks. No error is thrown. No retry fires (the JSON *was* valid JSON). The user gets a confident, wrong answer, and nothing in the trace says "the argument was malformed."

```
The empty-query failure, start to finish
  model emits {"arguments":{"q":"..."}}   ← wrong key, valid JSON
     │  parseToolCall: name ok, input is an object → ACCEPTED
     ▼
  callTool(search_knowledge_base, {q:"..."})
     │  handler: args.query is undefined → query = ""
     ▼
  pipeline.query("")  → pgvector nearest-to-empty → noise chunks
     ▼
  model synthesizes over noise → confident wrong answer, NO error
```

A native provider rejects `{q:"..."}` because it violates `required:["query"]` — you never reach the tool. The emulated path sails right through. That asymmetry is the ceiling: buffr can be no more reliable than `gemma2:9b`'s ability to spell `query` correctly, every single time, with nothing catching it when it doesn't.

## Primary diagram

The full emulated round trip, with the hole marked.

```
Emulated tool calling, end to end (★ = the missing check)
  loop wants a tool
     │ toolSchemas
     ▼
  ┌─ GemmaModelProvider.complete ───────────────────────────────┐
  │  OUTBOUND  buildSystemText: schemas → JSON in system prompt   │
  │     │                                                         │
  │     ▼  chat to Ollama /api/chat                               │
  │  raw text  ← model, asked to emit JSON                        │
  │     │                                                         │
  │  INBOUND   parseAgentJson (fence → brace scan)                │
  │     │      parseToolCall (lenient name/arg keys)              │
  │     │                                                         │
  │     ├─ valid call?  ── yes ──►  ★ NO SCHEMA CHECK ──► tool_use│
  │     │                                                         │
  │     └─ no, looks like attempt? ── yes ── RETRY_NUDGE (once)   │
  │                                  no ──── return as prose      │
  └──────────────────────────────────────────────────────────────┘
     │
     ▼
  callTool(name, input)   ← input trusted as-is
```

## Elaborate

Why emulate at all, instead of swapping to a model with native tool calling? Because the constraint is *local and free*. buffr's whole premise is a private RAG agent that runs on your laptop with no API bill and no data leaving the machine. `gemma2:9b` is the price of that premise. The emulation is the bridge between "local model that only does chat" and "an agent loop that needs structured calls." It's a reasonable bridge — and the missing validation is the toll you haven't paid yet.

The lenient parsing (`tool | name | tool_name`, `arguments | input | args`) is a deliberate counterweight: since the model is unreliable about *format*, the parser is generous about format. That's correct. But generosity about *format* must not become generosity about *content*. Accepting three spellings of the key `tool` is fine. Accepting an arguments object that doesn't match the schema is the bug. The fix isn't to make parsing stricter — it's to add a *separate* validation step after parsing.

One more honest note: `parseAgentJson`'s brace scan (`indexOf('{')` to `lastIndexOf('}')`) is a substring grab, not a balanced-brace parser. If the model emits two JSON objects, or a `{` inside a string before the real object, the scan can slice the wrong span. It's good enough for a single-object reply and it's the pragmatic choice — but it's another place where "good enough for the common case" is doing load-bearing work.

## Project exercises

### Validate parsed tool arguments against the schema before calling the tool

- **Exercise ID:** [B4.3], Phase 4 (the primary exercise for this concept — Case B: this is the unbuilt feature that defines the file).
- **What to build:** Between `parseToolCall` returning a call and `complete` returning the `tool_use` block, validate `input` against the tool's `input_schema`. On failure, do not return the call — instead trigger the retry with a *specific* nudge naming the missing/wrong key. After the retry budget, surface a typed error rather than a silent empty-query search.
- **Why it earns its place:** This closes the single biggest reliability hole in the codebase — the no-arg-validation ceiling. It converts "confident wrong answer over noise" into "model gets told exactly what it got wrong and tries again." It's the difference between an emulated path that *resembles* native tool calling and one that *behaves* like it.
- **Files to touch:** `aptkit packages/providers/gemma/src/gemma-provider.ts` (add validation in `complete` after `parseToolCall`), `aptkit packages/runtime/src/json-output.ts` (reuse/extend `parseValidatedJson` with a JSON-schema validator), optionally a small Ajv dependency or a hand-rolled `required`-keys check.
- **Done when:** `{"arguments":{"q":"..."}}` no longer reaches `callTool` with an empty query — it either retries with a key-specific nudge or returns a typed validation error. Covered by a unit test feeding a wrong-key call and asserting no empty-string search occurs.
- **Estimated effort:** 3–5 hours.

### Make the brace scan balanced-brace aware

- **Exercise ID:** [B4.4], Phase 4.
- **What to build:** Replace the `indexOf('{')` / `lastIndexOf('}')` span grab in `parseAgentJson` with a balanced-brace scanner that returns the first complete top-level object, ignoring braces inside strings.
- **Why it earns its place:** The current scan silently mis-slices when the model emits prose-with-braces or multiple objects. A balanced scanner removes a whole class of "valid JSON parsed from the wrong span" bugs that are invisible until they bite.
- **Files to touch:** `aptkit packages/runtime/src/json-output.ts`.
- **Done when:** A reply like `Here is the call: {"tool":"x","arguments":{"query":"a {b} c"}} thanks` parses to the correct object, verified by a unit test, and existing tests still pass.
- **Estimated effort:** 2–3 hours.

## Interview defense

**Q: "How does tool calling work with a model that has no native tool support?"**

Emulation. The provider renders each tool's schema into the system prompt as JSON and instructs the model to reply with a single JSON object `{"tool":..., "arguments":...}`. Inbound, it hand-parses that out of the text — fenced block first, then a brace scan — and is lenient about key spelling. If it parses, it becomes a `tool_use` block the loop runs.

```
  schemas → prompt (out)   |   text → parseAgentJson → tool_use (in)
```

*Anchor: the model never sees a tools array — it sees instructions and JSON in its system text.*

**Q: "What's the reliability ceiling of that design?"** — the part people forget.

There is **no argument-schema validation** on the parsed call. The schema says `required:["query"]`, but nothing enforces it. If the model emits `{"q":"..."}` instead of `{"query":"..."}`, the call is accepted, the handler coerces the missing `query` to an empty string, pgvector returns noise, and the user gets a confident wrong answer with no error and no retry. A native provider rejects the bad args before you ever see them; the emulated path passes them straight through. That asymmetry is the ceiling — buffr is only as reliable as the model's spelling, with nothing catching the misses.

```
  {"q":"..."} → ACCEPTED (object) → query="" → search noise → wrong answer, no error
```

*Anchor: the schema is advisory text in a prompt, not a contract the runtime enforces — the missing check is the whole reliability story.*

## See also

- **`01-agents-vs-chains.md`** — the loop that calls `model.complete` and feeds the `tool_use` result back.
- **`03-react-pattern.md`** — what happens on the forced-final turn when tools are stripped (`forceFinal`).
- **`06-error-recovery.md`** — what a *thrown* tool error does (becomes an observation) vs the silent empty-query case this file describes (no throw at all).
- **`../01-llm-foundations/`** — structured output and why local models are unreliable producers of it.

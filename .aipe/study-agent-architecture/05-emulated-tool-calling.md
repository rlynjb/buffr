# Emulated tool calling on stock Gemma (prompt + parse)

**Industry name(s):** Tool-call emulation / prompted function calling / JSON
tool-call parsing · *Industry standard (for models without native tool APIs)*

---

## Zoom out, then zoom in

The bounded ReAct loop (`01`) reads `tool_use` blocks out of the model's
response. But Gemma 2 has **no native tool-calling API** — it can't take a
`tools` array and emit structured tool calls. So the provider fakes it: it
renders the tool schemas into the system prompt as text and parses a JSON blob
back out of the model's prose. This emulation is the layer that makes the whole
agent possible on a stock open model.

```
  Zoom out — emulation between the loop and Ollama

  ┌─ Agent loop (aptkit) ─────────────────────────────────────┐
  │  model.complete({ system, messages, tools: schemas })     │
  │  reads back: content blocks (text | tool_use)             │
  └───────────────────────────────┬───────────────────────────┘
                                  │ complete()
  ┌─ Gemma provider (aptkit) ─────▼───────────────────────────┐
  │  ★ render tools → system text · parse JSON → tool_use ★    │ ← we are here
  └───────────────────────────────┬───────────────────────────┘
                                  │ POST /api/chat
  ┌─ Provider (Ollama) ───────────▼───────────────────────────┐
  │  gemma2:9b — plain chat, no tool API, returns text         │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the provider is a translator. Outbound, it turns the loop's structured
`tools` array into "here are your tools, reply with JSON if you want one."
Inbound, it turns Gemma's messy text into a clean `tool_use` block — or, if the
JSON is botched, nudges once and retries. The loop above never knows the model
is faking it.

> Note: this file is the agent-architecture *placement* of tool calling — where
> it sits as the substrate under the loop. The prompt-craft of coaxing valid
> JSON out of a weak model, and structured-output parsing in general, are
> prompt-engineering / ai-engineering concerns; this file cross-links them
> rather than re-teaching them.

---

## Structure pass

**Axis: representation — what form does a "tool call" take at each layer?**

```
  "what shape is a tool call here?" — traced down

  ┌──────────────────────────────────────────────┐
  │ loop: structured tool_use block               │  → typed object
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ provider out: JSON instructions in prompt │  → text
      │ provider in:  parse JSON from prose        │  → text → object
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ Ollama: plain chat messages            │  → just strings
          └──────────────────────────────────────┘
```

**The seam:** the provider is the *only* place where text becomes structure. The
loop lives in a world of typed `tool_use` blocks; Ollama lives in a world of
strings. The provider is the adapter that lets a structured loop run on an
unstructured model. If the parse fails, the abstraction leaks — and the
provider's retry nudge is the patch over that leak.

---

## How it works

### Move 1 — the mental model

You know how you'd consume an API that returns a JSON string in a text field —
you `JSON.parse` it and handle the case where it's malformed? Emulated tool
calling is that, both directions: you *send* the tool contract as text and you
*parse* the reply as JSON, with a fallback when the model returns junk.

```
  The pattern — render out, parse in, retry once

  schemas ──render──► system: "tools: {...JSON...}. Reply with
                               {"tool":"name","arguments":{...}}"
                                       │
  Gemma replies (text) ◄───────────────┘
       │
   parseToolCall(text)
       ├─ valid JSON tool call ──► tool_use block ──► loop acts
       ├─ looks like a botched call ('{' present) ──► nudge + retry once
       └─ plain prose ──► text block ──► loop treats as final answer
```

### Move 2 — the mechanism, part by part

**Outbound: render the tools into system text.** The loop hands the provider a
`tools` array. `buildSystemText` stringifies each tool's name/description/schema
and appends a directive: "respond with ONLY a single JSON object … Otherwise,
answer the user directly." Bridge: it's string-templating a contract into the
prompt, the same way you'd build a system message by hand.

```
  system text Gemma actually sees:
    <the real system prompt>
    You can call the following tools:
    { "name": "search_knowledge_base", "description": "...",
      "input_schema": {...} }
    When a tool is needed, respond with ONLY a single JSON object, no prose:
    {"tool": "<tool name>", "arguments": { ...arguments... }}
```

What breaks without this: a native-tool loop hands Gemma a `tools` array it
ignores, and you get prose every turn — the agent never acts.

**Inbound: parse the reply into a tool call or text.** `parseToolCall` runs the
text through `parseAgentJson` (a tolerant JSON extractor) and accepts several
key spellings (`tool`/`name`/`tool_name`, `arguments`/`input`/`args`). A valid
parse becomes a synthetic `tool_use` block with a generated id; otherwise it
stays text.

```
  parseToolCall(text):
    obj = parseAgentJson(text)          // tolerant: digs JSON out of prose
    name = obj.tool ?? obj.name ?? obj.tool_name
    input = obj.arguments ?? obj.input ?? obj.args
    if name is string AND input is object → { name, input }   // tool call
    else → null                                               // treat as prose
```

What breaks without the lenient key matching: Gemma writes `"name"` instead of
`"tool"` one run in five and every such call is misread as prose. The
flexibility absorbs the model's inconsistency.

**The retry nudge — emulation's safety net.** If the reply *looks like* a botched
tool call (the cheap tell: it contains a `{`) but doesn't parse, the provider
appends a corrective `RETRY_NUDGE` and calls once more. Only botched attempts
retry — clean prose is taken as a real answer, not retried.

```
  Layers-and-hops — one complete() call with a retry

  ┌─ loop ───────┐ tools=[search]  ┌─ provider ──────┐ POST  ┌─ Ollama ──┐
  │ runAgentLoop │ ──────────────► │ render → system │ ────► │ gemma2:9b │
  └──────────────┘                 │ parse reply     │ ◄──── └───────────┘
        ▲                          │  botched JSON?  │  text
        │ tool_use / text          │   ► nudge+retry │ POST  ┌─ Ollama ──┐
        └──────────────────────────┤   (once)        │ ────► │ gemma2:9b │
                                    └─────────────────┘ ◄──── └───────────┘
```

What breaks without bounding the retry: `maxToolCallAttempts` defaults to 2 —
one try plus one nudge. Without a cap, a model that *always* returns slightly-off
JSON retries forever inside a single turn, multiplying cost.

### Move 3 — the principle

Tool calling is a *capability of the harness, not the model* when the model
doesn't have it natively. The structured loop above doesn't care whether tool
calls are native (Anthropic, OpenAI) or emulated (Gemma here) — the provider
adapter hides the difference behind one `complete()` contract. That adapter
boundary is why buffr can run a real agent on a stock open model: you don't need
a tool-trained model, you need a provider that fakes the protocol and parses
defensively.

---

## Primary diagram

```
  Emulated tool calling — full recap

  ┌─ loop hands provider: { system, messages, tools:[search] } ┐
  └───────────────────────────────┬────────────────────────────┘
                                  ▼
  ┌─ GemmaModelProvider.complete ──────────────────────────────┐
  │ buildSystemText: real system + rendered tool JSON + "reply  │
  │                  with {tool,arguments}"                     │
  │ attempt 0: POST /api/chat → raw text                       │
  │   parseToolCall(raw):                                      │
  │     ┌─ valid → tool_use{id, name, input} ──────────────────┤──► loop acts
  │     ├─ looksLikeToolAttempt('{') → append RETRY_NUDGE,      │
  │     │   attempt 1: POST again → parse                       │
  │     └─ plain prose → text block ────────────────────────────┤──► loop: final
  │ usage: prompt_eval_count / eval_count → trace               │
  └─────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Reached on every model turn of every run. buffr constructs the provider in
`session.ts:46` (wrapped in a context-window guard) and the loop calls
`complete()` each turn. Emulation is invisible to buffr's code — buffr wrote no
parsing; it gets `tool_use` blocks for free because the aptkit Gemma provider
fakes the protocol. This is the de-risked-first piece of the plan
(`agent-layer-plan.md:91` — "prove … `structured-generation` survives Gemma's
worse JSON … de-risk it first").

### Code, side by side

Outbound render (`@aptkit/provider-gemma/dist/src/gemma-provider.js:82-105`):

```
function buildSystemText(request) {
  const parts = [];
  if (request.system) parts.push(request.system);       ← the real system prompt
  if (request.tools?.length) {
    const rendered = request.tools.map((tool) => JSON.stringify({
      name: tool.name, description: tool.description ?? '',
      input_schema: tool.inputSchema }, null, 2)).join('\n\n');   ← schemas → text
    parts.push(['You can call the following tools:', '', rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',
      'Otherwise, answer the user directly in natural language.'].join('\n'));
  }
  return parts.join('\n\n');
       │
       └─ this is the whole "tools API" for Gemma: instructions in the prompt.
}
```

Inbound parse + retry (`gemma-provider.js:22-44`):

```
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {  ← maxToolCallAttempts=2
  const messages = attempt === 0 ? baseMessages
    : [...baseMessages, { role: 'user', content: RETRY_NUDGE }]; ← corrective nudge
  lastResponse = await this.chat({ model, messages, stream: false, signal });
  raw = lastResponse.message?.content ?? '';
  if (wantsTool) {
    const call = parseToolCall(raw);                          ← text → tool_use?
    if (call) return this.toResponse([{ type: 'tool_use', id: ..., name, input }], ...);
    if (looksLikeToolAttempt(raw)) continue;                  ← botched JSON → retry
  }
  break;                                                       ← plain prose → done
}
return this.toResponse([{ type: 'text', text: raw }], lastResponse);
       │
       └─ only a '{'-containing reply retries; clean prose is a real answer,
          never retried (gemma-provider.js:39, 127-129).
```

---

## Elaborate

Native tool calling (Anthropic, OpenAI) ships the tool schemas in a dedicated
API field and returns typed tool-call objects — no parsing, no retry. Emulation
is what you do when the model predates or omits that API. The cost is
reliability: a stock model returns malformed JSON some fraction of the time, so
you need the tolerant parser and the retry nudge. buffr accepts that cost
deliberately — the portfolio thesis (`agent-layer-plan.md:28`) is precisely
*"tame Gemma's messy JSON via structured-generation"* as the visible
engineering. The provider-adapter boundary also means buffr could swap to a
native-tool model by changing one line in `session.ts:46` — the loop and tools
are untouched.

The prompt-craft of *reliably* getting JSON out of a weak model (delimiters,
few-shot examples, schema echoing) is prompt-engineering territory; structured
output and JSON-validity-rate evals are ai-engineering territory. Both are
cross-linked below, not re-taught here.

---

## Interview defense

**Q: Gemma has no tool API. How does your agent call tools?**
The provider emulates it. Outbound it renders the tool schemas into the system prompt and demands a JSON reply; inbound it parses that JSON into a synthetic tool-call block, with one corrective retry if the JSON is botched. The agent loop above never knows it's emulated — it just sees `tool_use` blocks.

```
  schemas → prompt text → Gemma → JSON → parse → tool_use
                                   └─ retry once if botched
```
Anchor: "Tool calling is the harness's job when the model can't do it natively."

**Q: What's your failure mode and how do you bound it?**
Malformed JSON. I bound it two ways: lenient parsing that accepts several key spellings, and a capped retry — one nudge, `maxToolCallAttempts=2` — so a model that always returns slightly-off JSON can't loop forever inside one turn. Clean prose is never retried; only a `{`-containing botched attempt is.
Anchor: "Parse defensively, retry once, cap the attempts."

---

## Validate

1. **Reconstruct:** Draw the outbound-render / inbound-parse / retry flow from
   memory. (`gemma-provider.js:15-45, 82-105`.)
2. **Explain:** Why does only a reply containing `{` trigger a retry, while
   plain prose doesn't? (`gemma-provider.js:39, 127-129`.)
3. **Apply:** Gemma replies `{"name": "search_knowledge_base", "input": {...}}`
   (wrong keys vs the prompt's `tool`/`arguments`). Does it parse? (Yes — lenient
   key matching, `gemma-provider.js:117-119`.)
4. **Defend:** Argue the cost/benefit of emulated tool calling vs requiring a
   native-tool model, in buffr's self-hosted context.
   (`agent-layer-plan.md:28, 91`.)

---

## See also

- `01-bounded-react-loop.md` — consumes the `tool_use` blocks this produces
- `03-agentic-retrieval.md` — the one tool whose schema gets rendered
- `audit.md` — Lens 7 (tool calling, EMULATED)
- Structured output / JSON validity (sibling generator): `.aipe/study-ai-engineering/02-llm-foundations/04-structured-outputs.md`
- Prompt craft for tool JSON (sibling generator): `.aipe/study-prompt-engineering/` (structured-output / self-critique concepts)

---

Updated: 2026-06-24 — Emulation mechanics unchanged; re-pointed provider-construction
refs from the deleted `ask-cmd.ts:26` to `session.ts:46` (the long-lived chat session).
The one-line model-swap seam now lives there.

# 02 — Structured outputs via tool calling and schemas

**Industry term:** structured output / tool calling · the tool-calling prompt (the emulated JSON catalog) · *Industry standard*

This is the load-bearing file for buffr's prompt path. If you read one concept file closely, read this one — because buffr does the hard version of structured output: it runs tool calling on a model that **has no tool-calling API**. Everything Gemma "knows" about tools is text the provider wrote into the prompt, and everything the runtime "gets back" is JSON it parsed out of free-form model output. That whole round trip is emulated. Once you see it, you understand why grounding works, why it sometimes doesn't, and exactly where the retry lives.

## Zoom out, then zoom in

You've shipped a `fetch()` that posts JSON and parses JSON back — a typed contract on both ends. Tool calling is that contract at the LLM boundary: the model emits a structured call, your code runs it, hands back a structured result. The catch in buffr: the model on the other end can't speak the protocol natively, so the provider fakes both ends in prose.

```
  Zoom out — where structured output lives

  ┌─ Toolkit layer (RagQueryAgent) ─────────────────────────┐
  │  runAgentLoop  →  model.complete({ tools: [...] })       │
  └─────────────────────────┬────────────────────────────────┘
                            │  tool schemas (objects)
  ┌─ Provider layer (GemmaModelProvider) ──▼─────────────────┐
  │  ★ STRUCTURED OUTPUT, EMULATED ★                         │ ← we are here
  │  schemas → JSON-in-text catalog → parse reply → retry    │
  └─────────────────────────┬────────────────────────────────┘
                            │  POST /api/chat (no native tools)
  ┌─ Model ─────────────────▼────────────────────────────────┐
  │  Gemma 2 9B — emits prose; a tool call is just JSON prose │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: structured output is "make the model emit a shape your code can parse, then validate at the boundary and retry on failure." buffr exercises the emulated form of exactly that. The shape is a tool call: `{"tool": ..., "arguments": {...}}`.

## Structure pass

**Layers:** runtime (asks for a tool) → provider (emulates the protocol) → model (emits text). **Axis — "is this a tool call or a real answer?":** that single question is what the provider has to decide on every reply, and it's where the whole mechanism turns.

```
  axis: "is this reply a tool call, or the final answer?"

  ┌─ runtime ─┐ wants a tool   ┌─ provider ─┐ must classify  ┌─ model ─┐
  │ tools:[…] │ ═════════════► │ parse +    │ ◄════════════ │ emits   │
  └───────────┘                │ {-tell     │   raw text     │ text    │
                               └─────┬──────┘                └─────────┘
                                     │ flips here:
                            tool_use block  ──or──  text block
```

**Seam:** the parse-or-prose decision (`gemma-provider.js`). On one side the model speaks free text; on the other side the runtime needs a typed `tool_use` block. That boundary carries the entire structured-output contract — and it's the boundary that breaks when a "courteous" model wraps its JSON in a markdown fence.

## How it works

This one runs as a **load-bearing skeleton** — there's an irreducible kernel here that you should be able to reconstruct from memory.

### Move 1 — the mental model

The kernel of emulated tool calling is four parts: **render** the tools as text, **ask** for a JSON reply, **parse** the reply back, **retry once** if it looked like a botched attempt. Strip any one and it breaks in a specific way.

```
  The emulation kernel — render · ask · parse · retry

         ┌──────────────────────────────────────────┐
         │ 1. RENDER tools as JSON text in system    │
         │    "You can call the following tools: …"  │
         └────────────────────┬─────────────────────┘
                              ▼
         ┌──────────────────────────────────────────┐
         │ 2. ASK: "respond with ONLY a JSON object" │
         └────────────────────┬─────────────────────┘
                              ▼  model replies (free text)
         ┌──────────────────────────────────────────┐
         │ 3. PARSE reply → {name, input} or null    │
         └────────────────────┬─────────────────────┘
                    null & looks-like-attempt? │ yes
                              ▼
         ┌──────────────────────────────────────────┐
         │ 4. RETRY once with RETRY_NUDGE, then stop │
         └──────────────────────────────────────────┘
```

### Move 2 — the walkthrough, part by part

**Part 1 — RENDER: the outbound half.** Gemma can't take a `tools` array, so the provider serializes each tool definition to JSON and bolts it onto the system text, with an instruction sandwich around it.

```js
// gemma-provider.js:82 — buildSystemText
if (request.tools?.length) {
  const rendered = request.tools.map((tool) => JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema,            // the schema, as text
  }, null, 2)).join('\n\n');
  parts.push([
    'You can call the following tools:', '', rendered, '',
    'When a tool is needed, respond with ONLY a single JSON object, no prose:',
    '{"tool": "<tool name>", "arguments": { ...arguments... }}',
    'Otherwise, answer the user directly in natural language.',
  ].join('\n'));
}
```

What breaks if removed: drop the render and the model has no idea the tool exists — it'll hallucinate an answer instead of searching, and grounding collapses. This is the schema-first idea (`input_schema` is the schema) done the only way a no-tool-API model allows: as text.

**Part 2 — ASK: the JSON demand.** Notice the exact phrasing — *"respond with ONLY a single JSON object, no prose."* That's a prompt-text instruction doing protocol work. The spec note from every prompt guide ("'respond only in JSON' is not how you do this in 2026 — use schema mode") applies to frontier models with a schema-mode API. buffr's model has no schema mode, so the prompt-text instruction is the only lever. This is the honest exception: the blog-post advice assumes an API buffr's model doesn't have.

**Part 3 — PARSE: the inbound half.** The reply is free text. `parseToolCall` tries to pull a JSON object out of it.

```js
// gemma-provider.js:107
function parseToolCall(text) {
  let parsed;
  try { parsed = parseAgentJson(text); } catch { return null; }
  // accept tool | name | tool_name, and arguments | input | args
  const name  = obj.tool ?? obj.name ?? obj.tool_name;
  const input = obj.arguments ?? obj.input ?? obj.args;
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input };
}
```

And here's the part that earns the persona's scar tissue — `parseAgentJson` (`json-output.js:1`) **strips markdown fences first**:

```js
// json-output.js:1 — the fence is matched and unwrapped BEFORE JSON.parse
const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
const candidate = (fence ? fence[1] : text).trim();
```

This is the courteous-model bug, handled. I have shipped features that broke exactly here: schema mode returns conformant JSON, the model wraps it in a ```` ```json ```` fence "to be helpful," and a naive `JSON.parse` throws on the backticks. buffr's parser unwraps the fence, then falls back to a bounded `{`…`}` substring scan if that fails. That fallback is what lets a 9B model's slightly-chatty reply still parse.

**Part 4 — RETRY: bounded, and gated on a tell.** If the parse returns `null`, the provider does *not* blindly retry. It checks whether the reply even *looked* like a tool attempt — the cheap tell is a `{` anywhere in the text.

```js
// gemma-provider.js:39
if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);
// Only retry if it looked like a botched tool call; plain prose is a real answer.
if (looksLikeToolAttempt(raw)) continue;   // :127  return text.includes('{')
```

```js
// gemma-provider.js:25 — the retry appends a corrective nudge
const messages = attempt === 0 ? baseMessages
  : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];
// RETRY_NUDGE (:2): "Your previous reply was not a valid tool call. Respond with
// ONLY a single JSON object: {"tool": ..., "arguments": {...}}"
```

What breaks if removed: drop the `{`-tell gate and you'd retry on every plain-prose answer — burning a second model call and a nudge on replies that were *correct final answers*. The gate is what distinguishes "the model tried to call a tool and fumbled the JSON" from "the model answered you in English." Max attempts is 2 (`maxToolCallAttempts`, default clamped to ≥1 at `:13`) — one try, one nudge, then give up and treat the text as the answer.

**Optional hardening, not kernel:** the generic structured-output reprompt (`generateStructured` + `DEFAULT_STRICT_SUFFIX = "Return ONLY valid JSON - no prose, no markdown fences."`, `structured-generation.js:3`) is a *separate*, more general retry loop in aptkit — validate against a schema, retry once with a strict suffix appended to the last user turn. buffr's RAG path **does not call it**. It's the same idea as Part 4, generalized to arbitrary schemas, and it's the thing you'd reach for if buffr ever needed a validated JSON *answer* (not just a tool call). Worth knowing it's there; honest to say it doesn't fire today.

### Move 2.5 — what grounding actually rides on

The system prompt asks the model to "cite their sources" — but nothing enforces that. So why does grounding work? Because the tool result hands the model citations **pre-formatted**, and the model copies them.

```
  Why citations appear even though nothing enforces them

  ┌─ tool result ───────────────────────────────────────┐
  │  toResult():  citation: `[${docId}] ${snippet}`      │  ← preformatted
  │  search-knowledge-base-tool.js:61                    │     citation string
  └──────────────────────┬───────────────────────────────┘
                         │ enters prompt as a tool_result message
                         ▼
  ┌─ model ─────────────────────────────────────────────┐
  │  copies "[work.md] The author is a software…" verbatim│  ← grounding =
  └─────────────────────────────────────────────────────┘     copy, not obey
```

The instruction is the ask; the pre-formatted tool output is the mechanism. Citation is **unenforced** — if the model decides not to copy the bracket, nothing stops it. That's a real gap, and it's why [05-eval-driven-iteration.md](05-eval-driven-iteration.md) matters: you can't *know* citation rate without measuring it. Recalled conversation memory enters this exact same channel — `createConversationMemory` embeds past exchanges into the same store, and they surface through the same `search_knowledge_base` tool as retrieved context ([00-overview.md](00-overview.md)).

### Move 3 — the principle

Structured output is a contract enforced at a boundary you control — and when the model can't enforce it for you, *you* enforce it on the parse. Render the shape, ask for it, parse defensively (fences, substring scan), retry once on a real attempt, then stop. The discipline that separates demo from production isn't "use JSON mode" — it's "parse it, validate it, bound the retry, and know when *not* to retry." buffr's emulation is that discipline made visible because nothing is hidden behind a provider's schema-mode API.

## Primary diagram

The full emulated round trip — the recap.

```
  Emulated tool calling — one full round trip

  ┌─ Runtime ──┐ tools[]   ┌─ Provider (Gemma) ───────────────────────┐
  │ runAgent   │ ────────► │ RENDER schemas into system text          │
  │ Loop       │           │ ASK "ONLY one JSON object"               │
  └────▲───────┘           └───────────────┬───────────────────────────┘
       │ tool_use block                    │ POST /api/chat
       │                                   ▼
       │                            ┌─ Gemma 2 9B ─┐ emits free text
       │                            └──────┬───────┘
       │                                   │ raw
       │            ┌──────────────────────▼──────────────────────┐
       │            │ parseAgentJson: strip ``` fence → JSON.parse │
       │            │   → parseToolCall → {name,input} or null     │
       │            └──────────┬───────────────────┬───────────────┘
       │              parsed   │             null & │ "{"-tell
       └──────────────────────┘                    ▼
                                          ┌─ RETRY once w/ NUDGE ─┐
                                          │ else: text = answer   │
                                          └───────────────────────┘
```

## Elaborate

Tool calling vs JSON mode vs `response_format`: three flavors of the same goal across providers. Anthropic and OpenAI expose native tool APIs and schema modes where the *provider* enforces the shape; Google's Gemini exposes function calling similarly. Gemma 2 9B served by Ollama has none of these, which is why buffr emulates. The markdown-fence bug is provider-agnostic folklore that's actually true: courteous models wrap structured output in fences, and the fix is to unwrap before parsing — which is precisely what `parseAgentJson` does. When *not* to use structured output: open-ended generation and exploratory chains, where forcing a schema flattens the very thing you wanted. The runtime-side half of this contract — never letting parsed tool output trigger an unguarded side effect — is `study-ai-engineering`'s production-serving subject.

## Interview defense

**Q: How does this system do tool calling on a model with no tool API?**

It emulates the protocol in both directions. Outbound: the provider renders the tool schemas as JSON text into the system prompt and instructs "reply with ONLY a JSON object." Inbound: it parses the free-text reply back — stripping markdown fences first, then a bounded brace-scan fallback. If the parse fails but the reply contained a `{`, it retries once with a corrective nudge; if there's no `{`, it treats the text as the final answer.

```
  render → ask → parse(fence-strip) → {-tell? retry once : answer
```

Anchor: *"The load-bearing part people forget is the `{`-tell gate — you only retry when the reply looked like a botched tool call. Retry on plain prose and you burn a model call on a reply that was actually the correct answer. And the courteous-model fence bug is handled in `parseAgentJson`: it unwraps ```` ```json ```` before `JSON.parse`, because I've watched that exact thing break a parser in production."*

## See also

- [00-overview.md](00-overview.md) — where the tool catalog gets appended in the three-owner assembly
- [01-anatomy.md](01-anatomy.md) — the prompt sections this contribution is the fifth of
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — why unenforced citation means you must measure
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — the tool-call-vs-prose disambiguation as an output-mode boundary
- `study-agent-architecture` — the ReAct loop the tool call lives inside
- `study-ai-engineering` — the runtime-side defense: never let parsed output trigger an unguarded side effect

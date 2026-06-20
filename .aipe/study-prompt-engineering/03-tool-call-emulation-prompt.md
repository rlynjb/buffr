# Tool-call emulation prompt (the load-bearing one)

**Industry name(s):** Prompted function calling / tool-call emulation / JSON tool-call parsing · *Industry standard for models without native tool APIs*

---

## Zoom out, then zoom in

Frontier models take a `tools` array and emit native, parsed tool calls.
Gemma 2 9B takes no such thing. So buffr's whole agent stands on a
prompt trick: render the tool schemas into the system text as JSON,
demand the model reply with a single JSON object, and parse that object
back out of its prose. This is the most load-bearing prompt mechanism in
the entire system — strip it and there is no agent, just a chatbot that
can't search.

```
  Zoom out — emulation sits between the loop and Ollama

  ┌─ Agent loop (aptkit) ────────────────────────────────────────┐
  │  passes toolSchemas: [{ name, description, inputSchema }]     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ request.tools (a native shape Gemma can't use)
  ┌─ Gemma provider ──────────▼──────────────────────────────────┐
  │  ★ buildSystemText: render tools → text + JSON demand ★       │
  │     parseToolCall: JSON blob → { name, input }                │
  │     RETRY_NUDGE on botched JSON       (this guide)            │
  └───────────────────────────┬──────────────────────────────────┘
                              │ plain chat messages + a system string
  ┌─ Ollama: gemma2:9b ───────▼──────────────────────────────────┐
  │  text out — maybe `{"tool":…}`, maybe prose                   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **schema-as-text outbound, JSON-parse inbound,
retry-once on failure.** It re-implements, in a prompt, the contract a
frontier model gives you for free. Every piece is a hedge against the
weak model getting it wrong.

---

## Structure pass

**Layers.** Loop (speaks native `toolSchemas`) → provider (translates to
text + parses back) → Ollama/Gemma (speaks only chat text).

**Axis — *what represents a tool call at each layer?*** This is the
whole story:

```
  axis: how is "call the search tool" represented?

  ┌─ loop ──────────────┐  tool_use block {name,input}   → STRUCTURED object
  └─────────┬───────────┘
  ┌─ provider (out) ────┐  JSON text in system prompt     → flips to TEXT here
  └─────────┬───────────┘
  ┌─ Gemma ─────────────┐  prose containing `{"tool":…}`  → TEXT (unreliable)
  └─────────┬───────────┘
  ┌─ provider (in) ─────┐  parseToolCall → {name,input}   → flips BACK to STRUCTURED
  └─────────────────────┘
```

**The seam — the provider boundary, crossed twice.** On the way out,
structured `toolSchemas` flip to text (because Gemma can't read
structure). On the way back, text flips to structured (because the loop
can't read prose). The provider owns both flips. Every reliability
problem in buffr's agent lives at this seam: the model emitting almost-JSON,
wrapping it in a fence, or answering in prose when it should've called a
tool. The emulation prompt is the contract that tries to hold the seam
together.

---

## How it works

### Move 1 — the mental model

You know how a REST client serializes an object to JSON, sends it over
HTTP as text, and the server deserializes it back? Tool-call emulation
is that, but the "wire" is the model's prose and the "server" is a
regex-and-JSON.parse on the way back. The model is an unreliable
serializer you have to coax.

```
  The pattern — serialize-out, demand-JSON, parse-in, retry

   toolSchemas ──serialize──► system text: "{name,description,schema}"
                              + "respond with ONLY {"tool":…,"arguments":…}"
                                          │
                                   Gemma replies (text)
                                          │
        ┌─────────────── parseToolCall ───┴───────────────┐
        │ valid JSON object?                              │
   yes ─┤                                                 ├─ no & looks like
        ▼                                          a tool attempt ('{')
   { name, input }  ──► loop                              ▼
                                              RETRY_NUDGE, try once more
                                                          │
                                              still no → treat as prose answer
```

### Move 2 — the load-bearing skeleton

This concept has a kernel. Here's the smallest thing that's still the
pattern, then each part named by what breaks without it.

**1. Isolate the kernel.** Four parts:

```
  the irreducible emulation kernel

  render tools → text   +   "reply with ONLY JSON {tool,arguments}"
        +   parse JSON back to {name,input}   +   retry once on botched JSON
```

**2. Name each part by what breaks when it's gone.**

**The tool render** — `gemma-provider.js:86-93`. Each tool becomes
pretty-printed JSON: `{ name, description, input_schema }`.

```
  buildSystemText — the outbound render (gemma-provider.js:87-102)

  rendered = tools.map(t => JSON.stringify({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,            ← the model needs the arg shape
  }, null, 2)).join('\n\n')
  parts.push("You can call the following tools:\n\n" + rendered + …)
```

Remove it and the model has no idea what tools exist or what arguments
they take — it can't call `search_knowledge_base` because it's never
been told the name or that it needs a `query` string. This is what a
frontier model's `tools` array does natively; here it's hand-rendered
text.

**The JSON demand** — `gemma-provider.js:99-101`: "When a tool is
needed, respond with ONLY a single JSON object, no prose:
`{"tool": "<tool name>", "arguments": { ...arguments... }}`. Otherwise,
answer the user directly in natural language." Remove it and the model
describes what it *would* search for in prose, which `parseToolCall`
can't turn into an actual call. The "no prose" is load-bearing — a
courteous model that wraps the JSON in explanation breaks the parse.

**The parse** — `parseToolCall` (`:107-125`). It calls `parseAgentJson`
(fence-stripping + brace-scan, `json-output.js:1-19`), then accepts key
drift: `tool` OR `name` OR `tool_name` for the name (`:118`),
`arguments` OR `input` OR `args` for the args (`:119`). Remove the drift
tolerance and a model that says `{"name":…,"args":…}` instead of the
exact `{"tool":…,"arguments":…}` fails for no good reason. The drift
tolerance is scar tissue — weak models don't reliably hit the exact key
names.

**The retry nudge** — `RETRY_NUDGE` (`:2-3`) + the loop (`:22-43`). On a
botched tool call, re-prompt once: "Your previous reply was not a valid
tool call. Respond with ONLY a single JSON object: …". Remove it and one
malformed JSON sinks the whole turn. Bounded to `maxToolCallAttempts`
(default 2, `:13`) — one correction, then give up. The bound is what
keeps a stubborn model from looping forever.

**The `{`-tell** — `looksLikeToolAttempt` (`:127-129`):
`text.includes('{')`. This decides *whether to retry at all*
(`:39-40`). If the reply has no `{`, it's plain prose — a real answer —
and retrying would be wrong (you'd nag a model that correctly chose to
answer). If it has a `{`, the model *tried* to call a tool and botched
the JSON, so retry. Remove this and you either retry real answers
(annoying, wasteful) or never retry botched calls (fragile). It's a
one-character heuristic doing surprisingly load-bearing work.

**3. Skeleton vs hardening.** The kernel is render + demand + parse. The
**hardening** is everything that makes it survive a weak model: the key
drift tolerance, the retry nudge, the `{`-tell, the attempt bound.
Naming which is which is the lesson — a demo works with just the kernel;
production on Gemma needs every piece of the hardening.

### Move 2.5 — current vs future state

**Now:** emulation, because Gemma 2 9B has no native tool API. **Future,
if the model changes:** swap to a provider with native tool-calling and
this entire file's mechanism evaporates — the loop already speaks
structured `tool_use` blocks (`run-agent-loop.js:53`), so only the
provider changes. What *doesn't* have to change: the agent loop, the
tool definitions, the policy. That's the payoff of the provider seam.

```
  Phase A (now): Gemma          Phase B (native tool model)
  ┌──────────────────────┐      ┌──────────────────────┐
  │ render tools as text │      │ pass tools array     │
  │ parse JSON from prose│  →   │ read native tool_use │
  │ retry nudge, {-tell  │      │ (provider does it)   │
  └──────────────────────┘      └──────────────────────┘
  loop / tools / policy: UNCHANGED across the swap
```

### Move 3 — the principle

When the model can't give you a structured contract, you **manufacture
one in the prompt and enforce it in the parser** — and you spend most of
your effort on the hardening, not the happy path. The kernel (render +
demand + parse) is a demo. The retry, the key-drift tolerance, and the
`{`-tell are what make it survive contact with a 9B model. Emulation is
the proof that "tool calling" is a prompt-plus-parser pattern, not a
model feature — the model feature just hides the prompt.

---

## Primary diagram

```
  Tool-call emulation — full round trip

  ┌─ Loop (run-agent-loop.js) ───────────────────────────────────┐
  │  model.complete({ system, messages, tools: toolSchemas })    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ request.tools
  ┌─ Gemma provider OUT (gemma-provider.js:82-105) ──────────────┐
  │  system += "You can call the following tools:" + JSON render │
  │          + "respond with ONLY {"tool":…,"arguments":…}"      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ POST /api/chat (plain text)
  ┌─ Ollama gemma2:9b ────────▼──────────────────────────────────┐
  │  reply (text) — `{"tool":"search_knowledge_base",…}` or prose│
  └───────────────────────────┬──────────────────────────────────┘
                              │ raw text
  ┌─ Gemma provider IN (:107-125, :22-43) ───────────────────────┐
  │  parseToolCall: fence-strip → JSON → {name,input}            │
  │   valid?  → tool_use block → back to loop                    │
  │   '{' but invalid? → RETRY_NUDGE, once (bound :13)           │
  │   no '{'? → it's a prose answer, return as text              │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case.** Every buffr query that retrieves. You ask "what stack does
the author use" (`eval/queries.json`); turn 1, the model must emit
`{"tool":"search_knowledge_base","arguments":{"query":"stack tools"}}`.
The emulation prompt is what makes Gemma produce that, and `parseToolCall`
is what turns it into an actual `search_knowledge_base` invocation. No
emulation → the model answers from pre-training and never searches.

**Outbound — `gemma-provider.js:82-105`:**

```
  buildSystemText  (lines 94-102)

  parts.push([
    'You can call the following tools:', '',
    rendered,                                          ← tool JSON (name/desc/schema)
    '',
    'When a tool is needed, respond with ONLY a single JSON object, no prose:',
    '{"tool": "<tool name>", "arguments": { ...arguments... }}',  ← the exact shape demanded
    'Otherwise, answer the user directly in natural language.',   ← the prose escape hatch
  ].join('\n'))
       │
       └─ "no prose" is the line a courteous model breaks; "Otherwise…"
          is what lets the model legitimately NOT call a tool
```

**Inbound — `gemma-provider.js:107-125`:**

```
  parseToolCall  (lines 118-124)

  const name  = obj.tool ?? obj.name ?? obj.tool_name;     ← drift-tolerant name keys
  const input = obj.arguments ?? obj.input ?? obj.args;    ← drift-tolerant arg keys
  if (typeof name !== 'string') return null;               ← reject if no usable name
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input };
       │
       └─ the ?? chains absorb a weak model hitting the wrong key name —
          without them, {"name":…,"args":…} would fail though it's a valid intent
```

**The retry + tell — `gemma-provider.js:2-3, 25, 39-40, 127-129`:**
`RETRY_NUDGE` is appended as a user message on attempt 2 (`:25`); the
loop only continues (retries) if `looksLikeToolAttempt(raw)` —
`text.includes('{')` — is true (`:39-40, 127-129`). Plain prose breaks
out and is returned as the answer (`:42-44`).

---

## Elaborate

Prompted function calling predates native tool APIs — it's how the first
agent frameworks (early LangChain, ReAct papers) worked before OpenAI
shipped function calling in 2023. The pattern survives because not every
model has native tools: local/open models (Gemma, smaller Llamas) still
need it. The reader's AdvntrCue uses GPT-4's *native* tool calling — so
buffr is the reader's first encounter with the emulated form, and the
contrast is the lesson: native tools are this exact pattern, hidden
inside the provider.

The internet folklore says "just tell the model to output JSON." In a
production system on a 9B model, that folklore breaks: the model wraps
JSON in markdown fences (handled by `json-output.js:2`), drifts on key
names (handled by the `??` chains), and sometimes answers in prose when
it should call a tool (handled by the `{`-tell). The difference between
the blog-post version and buffr's version is precisely the hardening
layer. That's why this is the load-bearing file.

Where it connects: the JSON-parse-and-retry shape reappears in
structured-output generation (→ [`04`](04-structured-output-reprompt.md))
— same "generate, extract, validate, retry-once-stricter" skeleton,
different payload (a tool call here, a schema-validated result there).

---

## Interview defense

**Q: Gemma has no tool-calling API. How does buffr's agent call tools?**

Emulation. The provider renders the tool schemas into the system prompt
as JSON and demands the model reply with a single JSON object
(`gemma-provider.js:94-102`), then parses that object back out
(`parseToolCall:107`). The load-bearing part people forget: the
**`{`-tell** (`looksLikeToolAttempt:127`, literally `text.includes('{')`)
— it decides whether a malformed reply was a botched tool call worth
retrying or a legitimate prose answer worth keeping. Without it you
either nag correct answers or drop fixable tool calls.

```
  reply has '{' ?
   yes → tried a tool, botched → RETRY_NUDGE (once, bound at 2)
   no  → it's a real prose answer → keep it
  one char decides retry-vs-keep
```

**Anchor:** "Tool calling is a prompt-plus-parser, not a model feature —
buffr hand-rolls both at `gemma-provider.js:82` and `:107`."

---

## Validate

- **Reconstruct.** Draw the four kernel parts (render, demand, parse,
  retry) from memory. Which is hardening, which is kernel?
- **Explain.** Why does `parseToolCall` accept `name` and `tool_name` in
  addition to `tool` (`gemma-provider.js:118`)? What weak-model behavior
  is that absorbing?
- **Apply.** Gemma replies `Here's the call: {"tool":"search…",…}`. Walk
  it through `looksLikeToolAttempt` (`:127`), `parseAgentJson`
  (`json-output.js:2`), and `parseToolCall`. Does it succeed? (Yes —
  the `{`-tell passes, the fence/brace logic finds the object.)
- **Defend.** Argue what changes if buffr swaps Gemma for a native
  tool-calling model. Which files move, which don't? (Provider only;
  loop/tools/policy unchanged — Move 2.5.)

---

## See also

- [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
  — the "Always call search FIRST" instruction this emulation executes
- [`04-structured-output-reprompt.md`](04-structured-output-reprompt.md)
  — the same generate/parse/retry shape for schema-validated output
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md)
  — what happens when the loop drops the tools for the final turn
- [`study-agent-architecture/05-emulated-tool-calling.md`](../study-agent-architecture/05-emulated-tool-calling.md)
  — the same mechanism as an agent capability

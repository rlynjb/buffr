# Tool-call emulation

*Tool calling via prompted JSON / structured-output-as-transport — Industry
standard (the emulation pattern is what every framework does for models without a
native tool API).*

This is the load-bearing file. If you only read one pattern in this guide, read
this one — it's the trick that makes buffr a knowledge agent instead of a chatbot.

## Zoom out, then zoom in

In AdvntrCue you had GPT-4 with a native `tools` array — you described a function,
the API returned a typed `tool_call`, you ran it. Clean. buffr runs `gemma2:9b` on
Ollama, and **that API has no tool-calling endpoint.** So the capability has to be
manufactured out of plain text and a JSON parser. Every framework does this for
stock open models; here's exactly how aptkit does it.

```
  Zoom out — where tool emulation sits

  ┌─ aptkit agent ───────────────────────────────────────────┐
  │  RagQueryAgent.answer() → runAgentLoop                    │
  │    passes toolSchemas (JSON Schema objects)               │
  └───────────────────────────┬──────────────────────────────┘
                             │ system + toolSchemas
  ┌─ Gemma provider ────────────▼────────────────────────────┐
  │  ★ buildSystemText: render tools AS TEXT ★                │ ← we are here
  │  ★ parseToolCall: read JSON back out ★                    │
  │  ★ one retry, gated on a '{' tell ★                       │
  └───────────────────────────┬──────────────────────────────┘
                             │ messages[] (no native tools field)
  ┌─ Provider ──────────────────▼────────────────────────────┐
  │  Ollama /api/chat — sees only text, returns only text     │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **emulated tool calling** — using a structured-output
contract (reply with this exact JSON shape) as the *transport* for a function call
the model can't make natively. The question it answers: *how do you get a
tool-less model to use a tool?*

## Structure pass

Trace one axis — **what form is the tool call in at each layer?** — and watch it
change shape twice, round-trip.

```
  Axis: "what representation is the tool call in?"

  ┌─ aptkit agent ────┐  form: JSON Schema OBJECT (typed)
  │  toolSchemas[]    │
  └─────────┬─────────┘
          ══╪══ seam: schema → text  (the call STOPS being typed)
  ┌─ provider out ────▼┐ form: TEXT — schema serialized into the prompt
  │  buildSystemText  │
  └─────────┬─────────┘
            │  Ollama: text → text
  ┌─ provider in ─────▼┐ form: TEXT again — model's reply, maybe JSON, maybe prose
  │  raw response     │
  └─────────┬─────────┘
          ══╪══ seam: text → typed  (parseToolCall re-types it, OR gives up)
  ┌─ agent again ─────▼┐ form: typed {name, input} tool_use  — OR plain text answer
  └───────────────────┘
```

The two seams are the whole game: **schema→text on the way out**, **text→typed on
the way back**. Everything that breaks, breaks at the second seam — the model
returns text that *isn't* the JSON you demanded.

## How it works — load-bearing skeleton

This concept has an irreducible kernel. Here it is, smallest form that's still the
pattern:

```
  Kernel — emulated tool call

  1. render tools into system text + demand exact JSON shape
  2. call model
  3. try to parse JSON tool-call out of the reply
       ├─ parsed?        → return typed tool_use
       ├─ looks like a botched attempt ('{' present)? → retry ONCE with a nudge
       └─ plain prose?   → it's a real answer, return as text
```

Now, each part named by **what breaks if you remove it.**

### Part 1 — render tools as text (remove it: the model can't know the tool exists)

The model never receives a `tools` field. So the provider serializes each tool's
schema into the system prompt and states the contract in prose.

```ts
// gemma-provider.js:82-105 — the outbound half of emulation
function buildSystemText(request) {
  const parts = [];
  if (request.system) parts.push(request.system);          // aptkit's system string (Owners 1+2)
  if (request.tools?.length) {
    const rendered = request.tools
      .map((tool) => JSON.stringify({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema,                     // the JSON Schema, as text
      }, null, 2))
      .join('\n\n');
    parts.push([
      'You can call the following tools:', '',
      rendered, '',
      'When a tool is needed, respond with ONLY a single JSON object, no prose:',
      '{"tool": "<tool name>", "arguments": { ...arguments... }}',
      'Otherwise, answer the user directly in natural language.',
    ].join('\n'));
  }
  return parts.join('\n\n');
}
```

The contract is two-pronged on purpose: *JSON when you need a tool, prose
otherwise.* That `Otherwise` clause is what lets the same channel carry both a tool
call and a final answer — there's no separate "answer" mode.

### Part 2 — parse JSON back out (remove it: the model's reply is just a string)

The reply is text. `parseToolCall` tries to extract a tool call; if it can't, the
text *is* the answer.

```ts
// gemma-provider.js:107-125 — the inbound half, deliberately forgiving
function parseToolCall(text) {
  let parsed;
  try { parsed = parseAgentJson(text); }   // tolerant: strips fences, finds the JSON
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name  = obj.tool ?? obj.name ?? obj.tool_name;       // accept 3 synonyms for the key
  const input = obj.arguments ?? obj.input ?? obj.args;       // …and 3 for the args
  if (typeof name !== 'string') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name, input };
}
```

Two production tells here. First, `parseAgentJson` is *tolerant* — it strips
markdown fences before parsing, which is the spec's "courteous model wraps JSON in
\`\`\`json" defense baked into the parser. Second, accepting `tool`/`name`/`tool_name`
and `arguments`/`input`/`args` is an admission that **the model does not reliably
emit the exact key you demanded.** You asked for `tool`; sometimes it writes `name`.
Rather than fail, the parser shrugs and accepts the synonym. That's the difference
between demo code (assumes the model obeys) and production code (assumes it won't).

### Part 3 — retry once, gated on a `{` (remove it: a near-miss JSON dies as a wrong answer)

If parsing fails, you don't immediately give up *and* you don't retry forever. You
retry exactly once — but only if the reply *looks like* a botched tool call.

```ts
// gemma-provider.js:33-44 — the retry loop
if (wantsTool) {
  const call = parseToolCall(raw);
  if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);
  // Only retry if it looked like a botched tool call; plain prose is a real answer.
  if (looksLikeToolAttempt(raw)) continue;   // → next attempt appends RETRY_NUDGE
}
break;   // prose, or out of attempts → return raw as the text answer

// gemma-provider.js:127-129 — the cheap tell
function looksLikeToolAttempt(text) { return text.includes('{'); }
```

```ts
// gemma-provider.js:2-3, 25 — what the retry appends
const RETRY_NUDGE = 'Your previous reply was not a valid tool call. Respond with ONLY a single JSON object: '
  + '{"tool": "<tool name>", "arguments": { ...arguments... }}';
const messages = attempt === 0 ? baseMessages : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];
```

This is the load-bearing-part people forget, and the one to name in an interview.
**The `{`-tell is the whole reason this doesn't waste a turn.** If the model
answered in clean prose (no `{`), that's a *real answer* — retrying would corrupt
a good response into a demand for JSON the user didn't want. If the model produced
`{ "too` then choked, the `{` says "it was *trying* to call a tool and fumbled the
JSON" — that's worth one corrective nudge. One cheap character disambiguates
"genuine prose answer" from "botched tool attempt." Cap is `maxToolCallAttempts`,
default 2 (`gemma-provider.js:13`) — one initial + one retry, then accept whatever
came back. No infinite loop.

```
  Execution trace — the decision per reply

  reply = '{"tool":"search_knowledge_base","arguments":{"query":"coffee"}}'
    parseToolCall → {name, input}      → return tool_use         ✓ (no retry)

  reply = 'Sure! {tool: search...'   (botched)
    parseToolCall → null
    looksLikeToolAttempt('{')  → true  → retry with RETRY_NUDGE
      reply2 = '{"tool":"search_knowledge_base",...}'  → tool_use ✓

  reply = 'You take your coffee black.'  (clean prose)
    parseToolCall → null
    looksLikeToolAttempt → false (no '{') → break, return as ANSWER ✓ (no wasted retry)
```

### Skeleton vs. hardening

Kernel: render-as-text + parse-back + the prose/JSON fork. Everything else is
hardening — the key synonyms, the fence-stripping in `parseAgentJson`, the
`{`-gated single retry, the attempt cap. Strip the hardening and it still
*works*, just fails more often. Strip the kernel and there's no tool calling at all.

## Primary diagram

```
  Emulated tool call — full round trip

  ┌─ aptkit agent ──┐  toolSchemas (typed)   ┌─ Gemma provider ───────────────┐
  │ runAgentLoop    │ ─────────────────────► │ buildSystemText:               │
  └─────────────────┘                        │   system + tools-as-JSON-text  │
                                             │   + "reply ONLY {tool,args}"   │
                                             └───────────────┬────────────────┘
                                                  text only  │
                                             ┌─ Ollama ──────▼──── gemma2:9b ──┐
                                             └───────────────┬────────────────┘
                                                   raw text  │
                                             ┌─ provider ────▼────────────────┐
                                             │ parseToolCall(raw)             │
                                             │   ├ JSON → typed tool_use ─────┼─► back to loop
                                             │   ├ '{' but bad → RETRY_NUDGE  │   (run the tool)
                                             │   └ prose → final answer ──────┼─► return text
                                             └────────────────────────────────┘
```

## Elaborate

Every agent framework ships this for models without native tool support — it's the
"ReAct / JSON-mode" fallback. The canonical references (Anthropic's tool-use guide,
the OpenAI cookbook on function calling) describe the *native* path; the emulated
path is what you build when you drop to a local open model to cut cost or run
offline. buffr's whole reason to emulate is the local/offline/single-device posture
(`context.md`: Ollama-served gemma2:9b). The tradeoff is stated without flinching:
you trade GPT-4's reliable native tool calls for a local model and pay for it with
a parser, three key synonyms, and a retry. For a personal single-device KB, that's
the right call.

The honest weakness: **no few-shot example in the tool prompt.** The single
highest-leverage improvement here is to drop one worked `{"tool","arguments"}`
example into `buildSystemText` — the spec's "an example constrains output more than
an instruction" applied exactly where it pays. That's an aptkit change, not a
buffr one, but it's the move.

## Project exercises

### PE-1 — Answer-grounding eval over the emulated loop

- **What to build:** an eval that runs real questions through `session.ask()` and
  scores whether the final answer (a) triggered a tool call and (b) cited a `[docId]`
  that's actually in the retrieved set — not just retrieval precision.
- **Why it earns its place:** `audit.md §5` — the existing eval scores retrieval,
  never the prompt's output. This closes the prompt-eval gap and would catch a
  Gemma upgrade that regresses tool-call JSON formatting.
- **Files to touch:** new `eval/answers.json`, new `src/cli/answer-eval-cmd.ts`,
  reuse `createChatSession`.
- **Done when:** the CLI prints tool-call rate and citation-validity rate over a
  labeled set, and fails loudly if tool-call rate drops below a threshold.
- **Estimated effort:** half a day.

### PE-2 — Few-shot the tool prompt

- **What to build:** since `buildSystemText` is aptkit-owned, prove the win in a
  local test harness: copy the function, add one in-context example of a correct
  tool call, measure retry-rate delta on a fixed question set.
- **Why it earns its place:** `audit.md §8` — converts a "not yet exercised"
  concept into a measured result, the senior move per the spec.
- **Files to touch:** a throwaway test under `test/`; no buffr source changes.
- **Done when:** you can state "one example cut botched-tool-call retries from X% to
  Y%" with numbers.
- **Estimated effort:** a few hours.

## Interview defense

**Q: "How does a model with no tool API call a tool?"**
Verdict first: you emulate it as structured output. Render each tool's JSON Schema
into the system prompt, demand the model reply with exactly `{"tool","arguments"}`,
and parse that JSON back into a typed tool call. The load-bearing detail most people
miss is the *retry gate*: you only re-prompt for JSON if the reply contains a `{`.
A clean-prose reply is a real answer — retrying it would corrupt a good response.
One character disambiguates "botched tool call" from "genuine answer."

```
  render schema → text  →  model replies text  →  parse JSON back
                                                    ├ ok → tool_use
                                                    ├ '{' → retry once
                                                    └ prose → answer
```

Anchor: *"The `{`-tell is what keeps the retry from eating good answers."*

## See also

- [`01-three-owner-prompt-assembly.md`](01-three-owner-prompt-assembly.md) — this is Owner 3
- [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) — what the tool returns once called
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md) — how the loop forces a final answer after tools
- [`06-structured-output-reprompt.md`](06-structured-output-reprompt.md) — the same parse→validate→retry shape, generalized
- `study-agent-architecture` — the turn loop that calls this provider

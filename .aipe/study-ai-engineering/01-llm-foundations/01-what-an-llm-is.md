# What an LLM Is

*Industry name: large language model (LLM) / autoregressive transformer. Type: **Industry standard.***

## Zoom out, then zoom in

Here is the whole buffr stack, top to bottom. The thing this file is about — the model itself — is one box near the bottom, marked ★.

```
buffr stack — where the model sits
┌───────────────────────────────────────────────────────────┐
│ chat.tsx (Ink TUI)        you type → setTurns → spinner     │ UI
├───────────────────────────────────────────────────────────┤
│ session.ask()            persist turn → agent.answer()      │ orchestration
├───────────────────────────────────────────────────────────┤
│ RagQueryAgent.answer()   runAgentLoop, maxTurns:6           │ agent loop
├───────────────────────────────────────────────────────────┤
│ ContextWindowGuardedProvider   {maxTokens:8192} gate        │ guard
├───────────────────────────────────────────────────────────┤
│ ★ GemmaModelProvider.complete()   tokens in → content out   │ THE MODEL
├───────────────────────────────────────────────────────────┤
│ Ollama HTTP  POST /api/chat  → gemma2:9b weights            │ runtime
└───────────────────────────────────────────────────────────┘
```

Everything above the ★ is plumbing you wrote. The ★ box is the only place "intelligence" happens — and it is far dumber than the plumbing makes it look. Strip away the agent loop, the guard, the TUI, and what's left is a function: you hand it text, it hands you text back. That's the whole contract. This file is about taking that literally.

## Structure pass — trace *state* down the stack

Pick one axis: **where does state live?** Trace it from the top box to the bottom and watch it vanish.

```
state ownership, top → bottom
 chat.tsx                 │ holds turns[] in React state     ← remembers
 session.ask()            │ holds conversationId, pool        ← remembers
 RagQueryAgent.answer()   │ holds nothing between calls       ← forgets
 GemmaModelProvider       │ holds nothing between calls   ★   ← forgets
 ─────────────────────────┼─────────────────────────────  THE SEAM
 gemma2:9b weights        │ frozen, identical every call      ← cannot remember
```

The seam is right above the model. Above it, state accumulates (your conversation, your DB rows). At and below the model, **there is no state** — the weights are frozen, the function is pure, and every call starts from zero. The only way the model "knows" anything about this turn is what you put in the input string *this call*. That single fact — memory lives above the seam, never in the model — is what makes RAG (03) and conversation memory (04) necessary instead of optional.

## How it works

### Move 1 — the mental model: a pure function

You already know pure functions from frontend. `formatPrice(cents) → "$4.20"` — same input, deterministic output, no hidden state. An LLM is that shape, with one twist: the output is sampled from a probability distribution, so it's a *pure function with a random seed*, not a deterministic one. Same input can give different text (that's sampling — file 03). But it never *remembers* the last call.

```
the model as a function
        input tokens                         output content
   ┌──────────────────────┐             ┌──────────────────────┐
   │ system prompt        │             │ {type:'text',        │
   │ + profile (me.md)    │  ──────▶    │  text:'...'}         │
   │ + tool schemas       │   f(x)      │   OR                 │
   │ + the question       │             │ {type:'tool_use',    │
   │ + retrieved chunks   │             │  name, input}        │
   └──────────────────────┘             └──────────────────────┘
        one big string                    one structured block
            ▲
            └─ everything the model "knows" this turn is in here
```

That's it. There is no fifth input called "what we talked about yesterday." If it's not in the string on the left, the model cannot use it.

### Move 2 — the moving parts

#### The input is assembled, then flattened to text

Buffr builds a structured `ModelRequest` (system, messages, tools), but `gemma2:9b` can't take structured tools, so the provider flattens everything into plain strings before the HTTP call. This is `buildMessages` in the Gemma provider (`packages/providers/gemma/src/gemma-provider.ts:94–108`):

```ts
private buildMessages(request: ModelRequest): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];
  const system = buildSystemText(request);        // ← tools get rendered INTO this text
  if (system) messages.push({ role: 'system', content: system });
  for (const message of request.messages) {
    messages.push({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : flattenContent(message.content),       // ← structured blocks → string
    });
  }
  return messages;
}
```

The annotation that matters: by the time the input crosses the wire, it is **one array of `{role, content:string}`**. The model never sees a "tool" type. The structure you carefully built upstream is theatre below the seam — it's all text.

```
upstream structure → wire reality
  ModelRequest                       Ollama /api/chat body
  ┌─────────────────┐                ┌──────────────────────────┐
  │ system: "..."   │                │ messages: [              │
  │ tools: [{...}]  │  buildMessages │   {role:'system', ...},  │
  │ messages: [...] │  ────────────▶ │   {role:'user', ...}     │
  └─────────────────┘                │ ], stream:false          │
   typed, structured                 └──────────────────────────┘
                                       flat strings only
```

#### The output is text, or text *parsed* as a tool call

The HTTP response is always text (`message.content`). The provider then decides: is this text actually a tool call in disguise? `complete()` (`gemma-provider.ts:52–92`):

```ts
raw = lastResponse.message?.content ?? '';
if (wantsTool) {
  const call = parseToolCall(raw);               // try to read JSON {"tool":...} out of the text
  if (call) {
    return this.toResponse(
      [{ type: 'tool_use', id: this.nextToolUseId(call.name), name: call.name, input: call.input }],
      lastResponse,
    );
  }
  if (looksLikeToolAttempt(raw)) continue;        // looked like a botched tool call → retry once
}
return this.toResponse([{ type: 'text', text: raw }], lastResponse);
```

So `complete()` returns one of two content shapes — `{type:'text'}` or `{type:'tool_use'}` — but **both come from the same text response**. The `tool_use` block is something *buffr's code* manufactured by parsing JSON out of prose. The model emitted characters; the structure is downstream interpretation. (Full treatment in file 04.)

```
output: one text, two interpretations
   Ollama returns:  '{"tool":"search_knowledge_base","arguments":{"query":"..."}}'
                            │
                  parseToolCall(raw)
              ┌─────────────┴─────────────┐
        parses?                       doesn't parse?
              │                             │
    [{type:'tool_use', ...}]      [{type:'text', text: raw}]
```

#### No memory: every `answer()` starts cold

`RagQueryAgent.answer()` (`packages/agents/rag-query/src/rag-query-agent.ts:62`) takes a `question` string and runs a fresh loop. It holds no history field. Buffr's own `session.ts` even calls this out in a comment: *"RagQueryAgent.answer() treats each question independently."* The model's "memory" of your last turn is reconstructed *every call* from retrieval (the `search_knowledge_base` tool) and the injected profile — never from the model itself.

### Move 3 — the principle that generalizes

> **Treat the LLM as exactly a function: `f(string) → string`. Every bug that isn't a parsing bug is a "you put the wrong thing in the string" bug.**

The model didn't "forget" your name — your name wasn't in the input. It didn't "ignore" the document — the document wasn't retrieved into the prompt. It didn't "hallucinate maliciously" — you gave it a question with no grounding and sampled from its prior. Once you stop anthropomorphizing the box and start auditing the input string, debugging gets boring in the good way.

## Primary diagram

The full picture: structured upstream, flat at the seam, text out, interpreted downstream, zero memory.

```
the LLM, end to end in buffr
  session.ask("what's my deploy command?")
        │  (state lives here and above)
        ▼
  RagQueryAgent.answer(q)  ── builds ModelRequest {system, tools, messages} ──┐
        │                                                                      │
  ════════════════════════════ THE SEAM (no state below) ════════════════════ │
        ▼                                                                      │
  GemmaModelProvider.complete(request)                                         │
        │  buildMessages → flat [{role,content:string}]                        │
        ▼                                                                      │
  Ollama POST /api/chat → gemma2:9b → message.content (TEXT)                   │
        │                                                                      │
        ▼  parseToolCall(raw)                                                  │
  ┌──────────────┬─────────────────┐                                          │
  {type:'text'}   {type:'tool_use'} ────────────────────────────────────────┘
        │                                  (loop feeds tool result back as new input)
        ▼
  finalText → session persists it → React renders it
```

## Elaborate

- **Origin.** "Attention Is All You Need" (2017) gave the transformer; GPT-2/3 made the autoregressive "predict the next token" framing dominant. `gemma2:9b` is Google's open-weight model in that lineage, 9 billion parameters, run locally by Ollama.
- **Adjacent concepts.** *Tokenization* (02) is how the input string becomes the actual integers the function consumes. *Sampling* (03) is the random-seed knob on this function. *Provider abstraction* (08) is the seam between buffr and "which function" — swap `gemma2:9b` for another and the contract holds.
- **What to read next.** File 02 — because "tokens in, tokens out" is literally true, and the token count is the budget everything else fights over.

## Project exercises

### Prove the model is stateless

- **Exercise ID:** [B1.1] (Phase 1 — LLM foundations)
- **What to build:** A throwaway script that calls `agent.answer("My name is Rein.")` then `agent.answer("What is my name?")` on the *same* session and asserts the second answer does **not** contain "Rein" (because nothing persisted it into the second input). Then add the name to the profile and watch it appear.
- **Why it earns its place:** Nothing teaches "the model has no memory" like watching it fail to remember a thing you just said, then succeed once you put that thing in the input string.
- **Files to touch:** new `scripts/prove-stateless.ts`; read-only against `src/session.ts`, `src/profile.ts`.
- **Done when:** the first assertion (no recall) passes and the second (recall via profile) passes, in one run.
- **Estimated effort:** <1hr

### Log the exact string crossing the seam

- **Exercise ID:** [B1.2] (Phase 1 — LLM foundations)
- **What to build:** Wrap `GemmaModelProvider` with a thin logging provider (same `complete` signature) that writes the flattened `messages` array to a file before delegating. Read one real chat turn's wire input.
- **Why it earns its place:** Makes the seam concrete — you see that the "structured" tool schema is just text inside the system message.
- **Files to touch:** new `src/logging-provider.ts`; one-line swap in `src/session.ts:46` to wrap the Gemma provider.
- **Done when:** a `wire-input.json` file shows the system message containing the rendered tool JSON, and the user message containing the raw question.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Where does the model store conversation history?"**

Model answer: It doesn't. The model is a stateless pure function — `f(tokens) → tokens`. The weights are frozen and identical on every call. Any "memory" is reconstructed upstream of the model: in buffr, that's the profile injected into the system prompt plus retrieval via the `search_knowledge_base` tool. `RagQueryAgent.answer()` holds no history field and treats every question independently, which is exactly why retrieval-based memory exists.

```
the trap question, answered
  "history?"  →  NOT in the model
                 ┌─────────────┴─────────────┐
            in the input string         in your DB/retrieval
            (profile + chunks)          (assembled fresh each call)
  ★ the weights remember NOTHING between calls
```

Anchor: *Memory lives above the seam; the model is `f(string)→string`.*

## See also

- `02-tokenization.md` — the input string is really a list of token integers; that list has a hard length limit.
- `08-provider-abstraction.md` — the seam formalized: `complete()` is the port; `gemma2:9b` is one adapter.
- `../04-agents-and-tool-use/` — what consumes the `tool_use` content block this file describes.

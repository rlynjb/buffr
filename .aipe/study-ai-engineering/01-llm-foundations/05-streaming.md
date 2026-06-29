# Streaming

*Industry name: token streaming / server-sent generation. Type: **Industry standard.***

## Zoom out, then zoom in

Generation is slow — `gemma2:9b` produces tokens one at a time over seconds. *Streaming* is whether you show them as they arrive or wait for the whole answer. Here's the chain, with every "wait for it all" gate marked ★.

```
buffr stack — the latency chain (all blocking today)
┌───────────────────────────────────────────────────────────┐
│ ★ chat.tsx   await session.ask() → Spinner "thinking…"      │ UI: spinner, no tokens
├───────────────────────────────────────────────────────────┤
│ ★ session.ask()   await agent.answer() (whole string)       │ awaits full answer
├───────────────────────────────────────────────────────────┤
│ ★ GemmaModelProvider   payload stream:false                 │ THE GATE
├───────────────────────────────────────────────────────────┤
│ Ollama /api/chat   buffers all tokens, returns one body     │ no SSE
├───────────────────────────────────────────────────────────┤
│ gemma2:9b   generates token by token (internally)           │ the only place tokens flow
└───────────────────────────────────────────────────────────┘
```

The model *does* produce tokens incrementally — that's how transformers work. But buffr throws that incrementality away: `stream:false` tells Ollama to buffer the whole answer, the agent awaits the full string, and the TUI shows a spinner until it's done. **This is Case B: streaming isn't wired.** This file teaches the pattern and the exact three gates you'd open.

## Structure pass — trace *time-to-first-visible-output* across the stack

Pick one axis: **how long until the user sees the first character of the answer?** Trace it.

```
time-to-first-token (TTFT) vs time-to-full-answer
  NON-STREAMING (buffr today)
  t=0 ──── generate all N tokens ──── t=full │ user sees: spinner ……… ANSWER
                                             ▲ first char and last char arrive together

  STREAMING (the goal)
  t=0 ─ tok ─ tok ─ tok ─ … ─ tok ─ t=full   │ user sees: A…n…s…w…e…r as it forms
        ▲ first char arrives early
```

The seam is `stream:false`. With it set, TTFT equals time-to-full-answer — the user stares at a spinner for the entire generation, then the whole block appears. Open the gate and TTFT drops to the first token, which for a multi-second answer is the difference between "frozen?" and "it's working." Same total time; wildly different *felt* latency.

## How it works

### Move 1 — the mental model: a Promise vs an async iterator

You know both shapes from frontend. `await fetch().then(r => r.json())` resolves once, with everything. `for await (const chunk of response.body)` yields pieces as they arrive (think reading a `ReadableStream`). Non-streaming generation is the first; streaming is the second. Buffr is fully in the first.

```
two return shapes
  Promise<string>          │ resolves once, full answer │ buffr: agent.answer()
  AsyncIterable<token>     │ yields token, token, token │ goal: stream into UI
  ───────────────────────────────────────────────────────────────────────
  same bytes, different arrival schedule
```

### Move 2 — the moving parts

#### Gate 1: the provider hard-codes `stream:false`

This is the root gate. The Gemma transport's payload type *only allows* `stream: false` — it's not even a variable. From `gemma-provider.ts:19–25` and the call at `:69–74`:

```ts
export type GemmaChatTransport = (payload: {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;                          // ← literally typed as false; streaming not an option
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<OllamaChatResponse>;        // ← returns ONE response, not a stream

lastResponse = await this.chat({ model: this.defaultModel, messages, stream: false, ... });
```

Annotation that matters: `complete()` returns `Promise<ModelResponse>` — a single resolved value. There's no streaming surface on the provider at all. Opening streaming means a new method (e.g. `completeStream`) returning an async iterable, because the type system forbids the current one from streaming.

#### Gate 2: the agent awaits the full string

`RagQueryAgent.answer()` (`rag-query-agent.ts:62–83`) returns `Promise<string>` — `finalText.trim()`. It runs the whole agent loop (retrieval, synthesis) and hands back one complete answer. Nothing partial escapes it.

```
gate 2: the agent's return contract
  answer(q): Promise<string>
        │  runAgentLoop → ... → finalText
        ▼
  return finalText.trim()   ← one string, fully formed, or nothing
```

#### Gate 3: the TUI shows a spinner, not tokens

`session.ask()` awaits the whole answer, then `chat.tsx` appends it as one turn. While waiting, `busy` is true and an Ink `<Spinner>` shows "thinking…". From `chat.tsx:27–34` and `:48–51`:

```tsx
const answer = await session.ask(q);                 // ← blocks until full answer
setTurns((t) => [...t, { role: 'buffr', text: answer }]);  // ← appended all at once
// ...
{busy ? (<Text color="yellow"><Spinner type="dots" /> thinking…</Text>) : (/* input */)}
```

Annotation that matters: the user gets a binary "thinking → done." There is no place in this component that receives partial text — `setTurns` is called exactly once per answer, with the complete string.

```
gate 3: the UI's two states
  busy=true  → <Spinner/> "thinking…"   ← no token visible
  busy=false → full turn appended       ← everything at once
  (no third state for "streaming in")
```

### Move 2.5 — current vs future state

**Current:** three gates, all closed. `stream:false` → `Promise<string>` → spinner. Felt latency = full generation time.

**Future (the exercise):** open all three. Provider gains a `completeStream` yielding tokens (Ollama supports `stream:true` with NDJSON chunks). Agent (or a thinner path that skips synthesis re-runs) forwards tokens. `chat.tsx` adds a partial-text state and appends chunks as they arrive. **Caveat from file 04:** streaming and the tool-call structured path conflict — you can't parse `{"tool":...}` until it's fully arrived, so streaming is for the *final synthesized answer*, not the tool-decision step.

```
current → future
  CURRENT: stream:false → Promise<string> → spinner
  FUTURE:  completeStream → AsyncIterable<token> → partial-text state
           ⚠ stream the ANSWER, not the tool-call JSON (must be whole to parse)
```

### Move 3 — the principle that generalizes

> **Streaming changes perceived latency, not actual latency. It's a UX lever, and it costs you the ability to parse the output until it's done — so you stream prose, never the structured decision.**

The total compute is identical whether you stream or not. What changes is whether the user watches a spinner or watches words form. The cost: any step that needs the *whole* output to make a decision (parsing a tool call, validating JSON) can't be streamed — it has to buffer. That's why even fully-streaming production systems stream the answer but buffer the function-call. Buffr buffers everything, which is *simpler* and *correct*, just less responsive.

## Primary diagram

The three closed gates and what opening them costs.

```
streaming in buffr — three gates
  gemma2:9b (tokens flow here internally)
        │
  ┌─ GATE 1: stream:false ──────────────┐  open → completeStream (async iterable)
  │  Ollama buffers, returns one body    │
  └──────────────────────────────────────┘
        │
  ┌─ GATE 2: answer():Promise<string> ──┐  open → forward tokens (skip synthesis re-run)
  │  agent awaits full finalText         │
  └──────────────────────────────────────┘
        │
  ┌─ GATE 3: <Spinner/> "thinking…" ────┐  open → partial-text state, append chunks
  │  TUI binary busy/done                │
  └──────────────────────────────────────┘
  consequence today: TTFT = full generation time
  caveat: stream the answer, NOT the tool-call JSON (file 04)
```

## Elaborate

- **Origin.** Streaming token generation became standard UX with ChatGPT (2022); the transport is usually Server-Sent Events or chunked NDJSON. Ollama supports it via `stream:true`, emitting one JSON object per token chunk.
- **Adjacent concepts.** *Structured output* (04) — the hard conflict; streamed JSON can't be parsed mid-flight. *Token economics* (06) — streaming doesn't change token count, only arrival timing, so the bill is identical. *Agents* (sub-section 04) — only the final synthesis step is safely streamable.
- **Honest gap.** Streaming is **not wired** — and the provider type literally forbids it (`stream: false` as a type, not a value). This isn't a flag flip; it's a new streaming method plus UI state. Don't undersell the work.
- **What to read next.** File 06 — token economics, where you'll see streaming changes *when* tokens arrive but not *how many* you pay for.

## Project exercises

### Stream tokens into the chat TUI

- **Exercise ID:** [B1.9] (Phase 1 — LLM foundations) — **Not yet implemented** (Case B; all three gates closed).
- **What to build:** Add a `completeStream` path: a buffr-side provider method (or wrapper) that calls Ollama with `stream:true` and yields tokens; have the session expose an async-iterable `askStream`; render incoming chunks into a live `buffr` turn in `chat.tsx` (new partial-text state). Stream **only the final synthesized answer** — keep the tool-decision step buffered so file 04's parser still works.
- **Why it earns its place:** This is the single biggest felt-latency win in the app, and it forces you to confront the streaming-vs-structured-output conflict directly.
- **Files to touch:** new `src/streaming-provider.ts` (Ollama `stream:true`); `src/session.ts` (an `askStream`); `src/cli/chat.tsx` (partial-text turn state). aptkit's `GemmaModelProvider` is consumed — wrap, don't edit.
- **Done when:** typing a question shows the answer forming token-by-token instead of a spinner-then-block, and tool calls still parse correctly.
- **Estimated effort:** 1–2 days

### Measure TTFT before vs after

- **Exercise ID:** [B1.10] (Phase 1 — LLM foundations)
- **What to build:** Log time-to-first-visible-token and time-to-full-answer for the same question, non-streaming vs streaming.
- **Why it earns its place:** Proves the "same actual latency, lower felt latency" claim with two numbers instead of vibes.
- **Files to touch:** instrumentation in `src/session.ts`; depends on [B1.9].
- **Done when:** the log shows streaming TTFT << non-streaming TTFT while time-to-full-answer is roughly equal.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Does buffr stream, and what would it take to add it?"**

Model answer: No — it's `stream:false` end to end. Three gates: the Gemma provider types `stream` as the literal `false` and returns `Promise<ModelResponse>`; the agent returns `Promise<string>`; the Ink TUI shows a spinner with no partial-text state. Adding streaming is a new `completeStream` yielding tokens from Ollama's `stream:true`, a session method that forwards them, and a UI state that appends chunks. The catch — and this is the important part — you stream the *final answer*, not the tool-call JSON, because you can't parse `{"tool":...}` until it's fully arrived. Streaming lowers perceived latency, not actual; the token count and bill are unchanged.

```
the answer in one frame
  buffr: stream:false → Promise<string> → spinner   (3 closed gates)
  to add: completeStream + session forward + UI partial state
  ★ stream the ANSWER, buffer the tool-call (can't parse a half JSON)
```

Anchor: *Three closed gates; streaming is felt-latency only, and never for the structured decision.*

## See also

- `01-what-an-llm-is.md` — the `complete()` contract that streaming would extend.
- `04-structured-outputs.md` — why the tool-call JSON can't be streamed.
- `06-token-economics.md` — streaming changes timing, not token count.

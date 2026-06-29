# Streaming

*Token streaming / incremental decoding — Industry standard.*

## Zoom out, then zoom in

The model generates tokens one at a time (`01-what-an-llm-is.md`). You get a choice about *when* the application sees them: stream each token as it's produced, or wait and hand over the whole string at the end. buffr waits. Here's the path that waits.

```
  Zoom out — where the answer is delivered in buffr

  ┌─ TUI layer (Ink) ───────────────────────────────────┐
  │  chat.tsx: setBusy(true) → await session.ask(q)      │ ← ★ awaits the WHOLE answer ★
  │            → setTurns([...t, {text: answer}])        │   one setState, one render
  └──────────────────────────┬───────────────────────────┘
                             │  Promise<string>
  ┌─ Session / Agent ────────▼───────────────────────────┐
  │  agent.answer(question): Promise<string>             │   returns a finished string
  └──────────────────────────┬───────────────────────────┘
                             │  HTTP /api/chat
  ┌─ Provider / Ollama ──────▼───────────────────────────┐
  │  GemmaModelProvider: stream: false → wait for all    │   no token-by-token
  └──────────────────────────────────────────────────────┘
```

Zoom in: buffr is **non-streaming end to end**. `agent.answer()` returns `Promise<string>`, the provider sends `stream: false`, and the Ink TUI shows a spinner until the full answer lands, then renders it in one shot. There's no token-by-token UI. That's a deliberate-but-not-required choice, and it's the honest gap this file covers: streaming would make `gemma2:9b` (which is slow on a laptop) *feel* far faster, and it isn't wired yet.

## Structure pass

Every layer agrees on "wait for the whole thing." Trace the axis **when is the first byte visible to the user?** down the stack.

```
  Axis: "when does the user see the first token?" — non-streaming

  ┌─ TUI (chat.tsx) ─────────────────────┐
  │  await ask() → render once           │  first byte = AT THE END
  └─────────────────────┬─────────────────┘
                        │  seam: would flip to streaming HERE (callback/async-iterator)
  ┌─ Provider (gemma) ──▼─────────────────┐
  │  stream: false → await full response  │  first byte = AT THE END
  └───────────────────────────────────────┘
```

The axis answer is the same at every layer — "at the end" — which tells you the seam isn't *active* anywhere. The interesting thing is *where it would flip*: the provider's `stream: false` is the source. Flip that to `stream: true` and you'd need every layer above it to change shape too — `complete` returns one `ModelResponse`, `answer()` returns one `string`, `ask()` returns one `Promise<string>`, and the TUI does one `setState`. Streaming would replace each "one" with "many," all the way up. That cascade is why it's not a one-line change.

## How it works

#### Move 1 — the mental model

You know the difference between `await response.json()` (you get the whole body at once) and `for await (const chunk of response.body)` (you process bytes as they arrive)? That's exactly non-streaming vs streaming. The strategy buffr uses: **block until the full generation finishes, then return one string.**

```
  Pattern — non-streaming (buffr) vs streaming (the alternative)

  NON-STREAMING (buffr today)
  send ──► [········ model generates all tokens ········] ──► whole string
           user sees: spinner ............................. then full answer

  STREAMING (not wired)
  send ──► tok─tok─tok─tok─tok─tok─tok─tok─tok─tok─► done
           user sees: "The"  "The capital"  "The capital is"  ... live
```

Same total time; wildly different *perceived* latency. Streaming shows the first token in ~one token's time; non-streaming shows nothing until the last.

#### Move 2 — the step-by-step walkthrough

**The provider asks Ollama not to stream.** The single source of buffr's non-streaming behavior is one literal in the chat payload.

```
  GemmaModelProvider.complete — gemma-provider.ts:69-75 (annotated)

  lastResponse = await this.chat({
    model: this.defaultModel,
    messages,
    stream: false,                      // ← THE choice: wait for the entire response
    ...
  });
  raw = lastResponse.message?.content ?? '';   // ← one complete string, all at once
```

`stream: false`. Ollama buffers the whole generation and returns it as one JSON object. `raw` is the finished answer; there is no per-token callback to hand upward.

**The agent returns one string, not a stream.** `RagQueryAgent.answer` is typed `Promise<string>` — it has no streaming surface to expose even if the provider had one.

```
  RagQueryAgent.answer — rag-query-agent.ts:62-83 (signature)

  async answer(question: string, ...): Promise<string> {   // ← Promise<string>, not a stream
    const { finalText } = await runAgentLoop({ ... });
    return finalText.trim() || FALLBACK_ANSWER;            // ← one resolved string
  }
```

So even before the TUI, the contract is "one string when done." buffr's `session.ask` (`src/session.ts:60`) inherits this: it `await`s `agent.answer` and returns the string.

**The TUI renders once, after the await.** The Ink component shows a spinner while `busy`, then drops the whole answer in with a single `setState`.

```
  Layers-and-hops — chat.tsx awaits, then renders once

  ┌─ chat.tsx onSubmit — chat.tsx:26-34 ─────────────────────────────┐
  │  setBusy(true)                                                   │
  │  const answer = await session.ask(q);   ← blocks for the WHOLE   │
  │  setTurns(t => [...t, {role:'buffr', text: answer}])  ← once      │
  │  setBusy(false)                                                  │
  └───────────────────────┬──────────────────────────────────────────┘
                          │ while awaiting:
                          ▼
  <Spinner/> "thinking…"   chat.tsx:48-51   ← all the user sees until the end
```

This is the exact analogue of a React component that shows a loading spinner during `await fetch()` and only renders content on success — no progressive reveal. For a fast endpoint that's fine; for a 9B model on a laptop, the spinner can sit for many seconds.

#### Move 2.5 — current state vs future state

This is built-but-not-streaming; here's the migration shape.

```
  Phase A (now) vs Phase B (Case B) — answer delivery

  Phase A — NON-STREAMING                Phase B — STREAMING
  ┌────────────────────────────┐         ┌─────────────────────────────────┐
  │ stream: false [gemma:71]   │         │ stream: true + token callback   │
  │ answer(): Promise<string>  │  ──►     │ answer(onToken): AsyncIterable  │
  │ chat.tsx: 1 setState       │         │ chat.tsx: setState per token    │
  └────────────────────────────┘         └─────────────────────────────────┘
  must change: provider stream flag + response shape (aptkit), answer()
  signature (aptkit), chat.tsx render loop (buffr). What does NOT change:
  retrieval, the agent loop logic, the token ledger.
```

The honest cost: the provider and `answer()` shape changes live in *aptkit*, which buffr never edits. So a pure-buffr Case-B can only stream the *final synthesis* if aptkit grows a streaming surface — otherwise buffr's exercise is to simulate progressive rendering (e.g. reveal the answer chunked) and write the spec for the aptkit change.

#### Move 3 — the principle

Streaming doesn't make generation faster — it makes it *feel* faster by moving the first visible token from "the end" to "almost the start." For a slow local model that's the cheapest UX win available. The architectural cost is that streaming turns every "return one value" into "yield many," cascading up through provider → agent → UI. buffr accepts the non-streaming simplicity today; the gap is real and the win would be felt immediately on a laptop running a 9B model.

## Primary diagram

```
  Streaming in buffr — non-streaming, end to end (and where it would flip)

  ┌─ TUI chat.tsx ─────────────────────────────────────────────────┐
  │  await session.ask(q)  →  <Spinner> until done  →  setState ×1  │  [chat.tsx:28,48]
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ Promise<string>
  ┌─ Agent rag-query-agent.ts ────▼─────────────────────────────────┐
  │  answer(): Promise<string>  →  one finalText                    │  [rag:62]
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ ModelResponse (whole)
  ┌─ Provider gemma-provider.ts ──▼─────────────────────────────────┐
  │  chat({ stream: false })  →  raw = full content                 │  [gemma:71] ← source
  └─────────────────────────────────────────────────────────────────┘
   to stream: flip the flag, then re-shape every layer above it
```

## Elaborate

Streaming exists because autoregressive generation is inherently sequential and slow — you can't produce the last token before the first — so the only lever on perceived latency is *showing work in progress*. Server-Sent Events and chunked-transfer HTTP are the usual transports; Ollama supports `stream: true`, returning newline-delimited JSON chunks. The reason streaming is near-universal in chat UIs is purely psychological: total time is identical, but a stream that starts in 200ms reads as "responsive" where a 6-second blank-then-dump reads as "broken."

The tension with buffr's other concerns: streaming complicates the token ledger (`06-token-economics.md` — you only get the final `eval_count` at the end of the stream anyway) and the trace sink (you'd trace the completed message, not each token). So streaming is mostly a *UI* concern that the backend can largely ignore until the final-usage event. That's why it's a clean, isolated Case-B rather than an entangled rewrite.

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **not yet exercised** — Case B (stream tokens to chat.tsx).

### EX-05-1 — Progressive answer reveal in the TUI

- **Exercise ID:** EX-05-1
- **What to build:** Without changing aptkit, make `chat.tsx` reveal the (already-complete) answer progressively — chunk the final string and `setState` it in pieces on a timer — so the UX prototypes streaming and you feel the perceived-latency difference. Document where the *real* token stream would plug in.
- **Why it earns its place:** Delivers the perceived-latency win and the render-loop change that a true stream needs, entirely on buffr's side; proves you understand the UI cascade.
- **Files to touch:** `src/cli/chat.tsx:26-34,48-51` (the onSubmit await + spinner/render).
- **Done when:** the answer types out progressively instead of appearing all at once, behind the same spinner-then-content flow.
- **Estimated effort:** 1-4hr

### EX-05-2 — Write the aptkit streaming-provider spec

- **Exercise ID:** EX-05-2
- **What to build:** A short design note (in buffr's docs, not aptkit) specifying the aptkit changes a real stream needs: `GemmaModelProvider` `stream: true` + token callback, `answer()` returning an async iterable, and how the final `eval_count` still reaches `SupabaseTraceSink`.
- **Why it earns its place:** Streaming's hard part is the cross-package contract; naming it precisely is the senior-engineer move, and it respects the "never edit aptkit here" rule.
- **Files to touch:** a new doc under buffr's repo; reference `gemma-provider.ts:71`, `rag-query-agent.ts:62`, `supabase-trace-sink.ts:73`.
- **Done when:** the note lists each signature change and the one place token usage is still captured.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Does buffr stream tokens? Why not?"**

No — it's non-streaming end to end. The provider sends `stream: false`, `answer()` returns `Promise<string>`, and the Ink TUI shows a spinner then renders the whole answer in one `setState`. It's a simplicity choice; for a slow local 9B model, streaming would be a big perceived-latency win.

```
  buffr: spinner ............... full answer  (no progressive reveal)
```

*Anchor:* `stream: false` at `gemma-provider.ts:71`; single `setState` after `await` at `chat.tsx:28-29`.

**Q: "Streaming doesn't make it faster — so why bother?"**

Total generation time is identical; streaming moves the *first visible token* from the end to the start, so it *feels* responsive instead of broken. On a laptop where `gemma2:9b` takes seconds, that perception is the whole point.

```
  same total time, different first-byte

  non-stream: |———————————————| answer   (first byte: end)
  stream:     |t·t·t·t·t·t·t·t·| done     (first byte: ~start)
```

*Anchor:* the cascade flips at one flag — `gemma-provider.ts:71` — but re-shapes every layer above.

## See also

- `01-what-an-llm-is.md` — why generation is sequential (the next-token loop).
- `06-token-economics.md` — why the token ledger is mostly unaffected by streaming.
- `08-provider-abstraction.md` — the provider that owns the `stream` flag.
- `../06-production-serving/` — latency as the real local budget.

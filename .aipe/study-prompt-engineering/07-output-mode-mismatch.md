# 07 — Output mode mismatch

**Industry term:** output-mode contract / format mismatch · the parse-or-prose disambiguation (`looksLikeToolAttempt`) · *Project-specific*

## Zoom out, then zoom in

You know the bug where one function returns a string and the caller expects a parsed object, so `.map` throws? Output-mode mismatch is that bug at the LLM boundary: one step emits JSON, the next expects markdown, the parser breaks. The cure is that every chain declares exactly one output mode. buffr's chain has one declared mode (prose) — and the interesting mismatch lives *inside* the loop, where the model alternates between JSON and prose and the provider must tell which it got.

```
  Zoom out — where output mode is decided

  ┌─ Toolkit ──────────────────────────────────────────────┐
  │  RagQueryAgent.answer → returns prose (finalText.trim)  │ ← one declared mode
  └─────────────────────────┬───────────────────────────────┘
                            │  but inside the loop…
  ┌─ Provider ──────────────▼───────────────────────────────┐
  │  ★ each reply: JSON tool call OR prose? ★               │ ← we are here
  │  looksLikeToolAttempt decides                           │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: output-mode mismatch is when the producer's format and the consumer's expectation disagree. buffr's chain output is unambiguous prose; the per-turn ambiguity (tool-call JSON vs answer prose) is resolved by a parse-time classifier.

## Structure pass

**Layers:** chain output (one mode) → per-turn reply (two possible modes) → the disambiguator. **Axis — "what format is this, and who decides?":**

```
  axis: "what format is this reply, and who classifies it?"

  ┌─ chain answer ─┐ mode: PROSE        decided by: contract (always)
  ├─ per-turn reply┤ mode: JSON | PROSE decided by: parseToolCall + {-tell
  └─ tool result ──┘ mode: JSON string  decided by: JSON.stringify (always)
```

**Seam:** the per-turn reply is the only ambiguous boundary. Everything else has a fixed mode; this one flips, and `gemma-provider.js` carries the classifier.

## How it works

### Move 1 — the mental model

The kernel: when a step can emit one of two modes, you need a deterministic classifier at the boundary, and a default for the ambiguous case. What breaks without it: you parse prose as JSON (throw) or treat a tool call as the final answer (the search never runs).

```
  Output-mode disambiguation — classify, then route

  model reply ──► parseToolCall ──► got {name,input}? ──► TOOL_USE mode
                       │                  │ no
                       │                  ▼
                       │           looksLikeToolAttempt (has "{")?
                       │            yes → retry once    no → PROSE mode
                       ▼
                   default: treat as PROSE (the final answer)
```

### Move 2 — the walkthrough

**The chain declares one output mode.** `RagQueryAgent.answer` returns `finalText.trim() || FALLBACK_ANSWER` (`rag-query-agent.js:51`) — always prose, never JSON. The consumer (`session.ask` → the Ink UI) renders it as text (`chat.tsx:29`). One producer mode, one consumer expectation. No mismatch at the chain boundary.

**The in-loop mismatch — JSON or prose?** Inside the loop, each model reply is ambiguous: it might be a tool call (`{"tool": ...}`) or it might be the answer in plain English. The provider classifies by *trying to parse* and falling back on a tell:

```js
// gemma-provider.js:36
const call = parseToolCall(raw);
if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);   // JSON mode
if (looksLikeToolAttempt(raw)) continue;   // looked like JSON but broke → retry
// else: fall through → treat raw as text  (PROSE mode)
```

The classifier is two-stage: a successful parse means JSON mode (emit a `tool_use` block); a failed parse *with a `{`* means "botched JSON, retry"; a failed parse *without a `{`* means prose — the real answer. The default lands on prose, which is the safe default: a plain-English reply is a legitimate final answer, so treating it as one is correct.

**Where this would break in review.** The mismatch to catch in code review: if a future chain expected the synthesis turn to return *JSON* (say, a structured answer with a `thinking` field, [09](09-chain-of-thought.md)) but the consumer parsed it as markdown — or vice versa. buffr avoids it by keeping the final mode prose-only. The moment a chain's declared output mode and its consumer's parse disagree, you get the classic break: `JSON.parse("Here's your answer: …")` throws, or a markdown renderer prints raw `{...}`.

### Move 3 — the principle

Every chain declares one output mode, and every mode boundary gets a deterministic classifier with a safe default. The mismatch bug is a contract bug — producer and consumer disagreeing on format — and the fix is to make the contract explicit and check it at the seam. buffr's safe default (ambiguous → prose) is the right call because a prose reply is always a valid answer; the failure mode you can't afford is silently parsing an answer as a tool call.

## Primary diagram

```
  buffr's output modes — fixed at the edges, classified in the middle

  ┌─ chain answer ─┐  mode: PROSE (always)        → Ink renders text
  ├─ per-turn reply┤  mode: JSON | PROSE          → looksLikeToolAttempt
  │                │    parse ok → tool_use         decides; default PROSE
  │                │    "{" + fail → retry once
  └─ tool result ──┘  mode: JSON string (always)  → fed back as message
```

## Elaborate

Output-mode mismatch is the loopd project's explicit concern (chains with declared output modes, JSON-vs-markdown contracts checked at composition). buffr's version is narrower because it has one chain with one final mode — the ambiguity is internal to the emulated tool-calling round trip ([02](02-structured-outputs.md)), not between composed chains. The general lesson transfers: any time two steps hand data to each other, name the format on both sides and check it at the seam. The interaction with structured output is direct — a few-shot example of the *exact* output mode ([08](08-few-shot.md)) is the cheapest way to stop a weak model from drifting between modes.

## Interview defense

**Q: This model alternates between tool calls and answers — how does the system tell them apart?**

By trying to parse and defaulting to prose. The chain's final output mode is always prose, but inside the loop each reply is ambiguous. The provider runs `parseToolCall`: success → tool-use mode; failure with a `{` present → "botched JSON, retry once"; failure without a `{` → prose, the real answer. The safe default is prose, because a plain reply is always a legitimate answer.

```
  parse ok → JSON mode | "{" + fail → retry | else → PROSE (default)
```

Anchor: *"The mismatch bug is a contract bug — producer and consumer disagreeing on format. buffr dodges it by keeping the chain's final mode prose-only and putting the only ambiguity behind one classifier. The default landing on prose is deliberate: silently treating an answer as a tool call would mean the search never fires."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the parse-or-prose classifier in full
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the chain whose single output mode this is
- [08-few-shot.md](08-few-shot.md) — an example of the exact mode as the cheapest anti-drift lever

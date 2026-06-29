# What an LLM Is

*Large language model · the next-token function — Industry standard.*

## Zoom out, then zoom in

Before anything clever — retrieval, agents, tool calls — there's one box at the center of buffr that does the actual thinking, and it's dumber than you'd guess. Here's where it sits.

```
  Zoom out — where the LLM lives in buffr

  ┌─ TUI layer (Ink) ───────────────────────────────────┐
  │  chat.tsx   →   session.ask(question)                │
  └──────────────────────────┬───────────────────────────┘
                             │  string in
  ┌─ Agent layer (aptkit) ───▼───────────────────────────┐
  │  RagQueryAgent.answer → runAgentLoop                  │
  │     loop: build prompt → ★ MODEL.complete ★ → parse  │ ← we are here
  └──────────────────────────┬───────────────────────────┘
                             │  HTTP POST /api/chat
  ┌─ Provider layer ─────────▼───────────────────────────┐
  │  GemmaModelProvider  →  Ollama  →  gemma2:9b weights  │
  └──────────────────────────┬───────────────────────────┘
                             │  retrieval is a separate hop
  ┌─ Storage layer ──────────▼───────────────────────────┐
  │  Postgres + pgvector (search_knowledge_base tool)    │
  └──────────────────────────────────────────────────────┘
```

Zoom in: that `★ MODEL.complete ★` box is the LLM. Strip away the framing and it's a **function** — you hand it a sequence of tokens, it hands you back the most-likely next tokens, one at a time, until it decides to stop. That's it. It is not a database (it doesn't *store* your documents — that's pgvector's job two layers down), and it is not a reasoner with a logic engine inside. It's a very good autocomplete that has read a lot. The single most useful mental correction for a frontend engineer pivoting in: treat it like a flaky `fetch()` to a probabilistic endpoint, not like a function you wrote.

## Structure pass

Three layers wrap the model in buffr. Trace one axis — **who owns the truth?** — down the stack and watch the answer flip.

```
  Axis: "who holds the ground truth?" — traced down the stack

  ┌─ Agent loop (RagQueryAgent) ─────────────┐
  │  owns the QUESTION + the conversation     │  truth = the user's intent
  └─────────────────────┬─────────────────────┘
                        │  seam: prompt assembly
  ┌─ Model (gemma2:9b) ─▼─────────────────────┐
  │  owns nothing durable; pure transform     │  truth = NONE (it guesses)
  └─────────────────────┬─────────────────────┘
                        │  seam: the tool call
  ┌─ Storage (pgvector) ▼─────────────────────┐
  │  owns the indexed documents               │  truth = the actual facts
  └───────────────────────────────────────────┘
```

The seam that matters is the one *above* the model: the agent must hand the model everything it needs as tokens, because the model owns no truth of its own. The model layer is stateless and forgetful — every call starts from zero. The whole RAG architecture exists because of this one fact: the model can't look anything up, so you have to retrieve the facts (pgvector) and paste them into the prompt before you call it. Hold that and the rest of buffr makes sense.

## How it works

#### Move 1 — the mental model

You know how a `fetch()` is a function from a request to a response — same inputs, you hope for same-ish outputs, but it's I/O so you wrap it in loading/error states? An LLM is that, with one twist: the output is *sampled*, so the same input can give different outputs. The underlying strategy: **predict the next token from all prior tokens, append it, repeat.**

```
  Pattern — the next-token loop (what gemma2:9b does internally)

  prompt tokens:  [The] [cat] [sat] [on] [the]
                                              │
                        ┌─────────────────────▼──────────────────┐
                        │  model: P(next | all prior tokens)      │
                        │  → ranks every possible next token      │
                        └─────────────────────┬──────────────────┘
                                              │ pick one (sampling)
                                              ▼
  appended:       [The] [cat] [sat] [on] [the] [mat]
                                              │
                        ┌─────────────────────▼──────────────────┐
                        │  feed the WHOLE sequence back in        │
                        └─────────────────────┬──────────────────┘
                                              ▼
                               ... until [<end>] token → stop
```

The loop runs inside the model on every call. buffr never sees individual tokens — it sees the final string — but that loop is what `eval_count` (output tokens) counts later in the token ledger.

#### Move 2 — the step-by-step walkthrough

**The function signature buffr actually calls.** Forget the math. From buffr's side, the LLM is one method: `complete(request) → response`. The request carries a system prompt, the messages so far, and (optionally) tool schemas; the response carries content blocks. Here's the real provider in aptkit, the thing `session.ts:46` wraps.

```
  GemmaModelProvider.complete — gemma-provider.ts:52-92 (annotated)

  async complete(request: ModelRequest): Promise<ModelResponse> {   // ← the function
    const baseMessages = this.buildMessages(request);               // tokens-in, assembled
    ...
    lastResponse = await this.chat({                                // HTTP → Ollama → gemma2:9b
      model: this.defaultModel,                                     // 'gemma2:9b'
      messages, stream: false, ...                                  // non-streaming: wait for all of it
    });
    raw = lastResponse.message?.content ?? '';                      // tokens-out, as one string
    ...
    return this.toResponse([{ type: 'text', text: raw }], lastResponse);
  }
```

One call in (`request`), one string out (`raw`). No memory between calls, no database read inside the model. Everything the model "knows" about your question came in through `request`.

**Where the model sits in buffr's wiring.** `src/session.ts:46` constructs it once, behind a guard:

```
  src/session.ts:46 — the model is built once per session

  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: cfg.ollamaHost }),   // ← the raw next-token function
    { maxTokens: 8192 }                                  // ← a wrapper that pre-checks size
  );
```

`GemmaModelProvider` is the function. `ContextWindowGuardedProvider` is a frontend-familiar idea: an input-validation wrapper that rejects the call *before* it goes out if the prompt is too big — like guarding a `fetch()` body against a max payload size. The model itself doesn't reject; the wrapper does.

**Why "not a database" is the load-bearing distinction.** The agent loop crosses a seam every time it needs a *fact*: it stops asking the model and calls `search_knowledge_base`, which hits pgvector.

```
  Layers-and-hops — the model can't look things up, so the loop does

  ┌─ Agent loop ─┐  hop 1: "answer this, here are tools"   ┌─ Model ──────┐
  │ runAgentLoop │ ───────────────────────────────────────►│ gemma2:9b    │
  └──────┬───────┘  hop 4: final grounded answer ◄───────── └──────┬───────┘
         │                                              hop 2 │ "call search_knowledge_base"
         │  hop 3: query → ranked chunks                      ▼
         │  ┌─ Storage (pgvector) ─────────────────────────────────┐
         └─►│ agents.chunks — the ACTUAL documents (the truth)     │
            └──────────────────────────────────────────────────────┘
```

Hop 2 is the model admitting it doesn't know — it emits a tool call instead of an answer. Hop 3 fetches the truth from storage. The model never touched the database; the loop did, then pasted the result back into the next prompt. If you forget this and expect the model to "remember" an indexed doc, you'll be confused why answers drift — it never had the doc unless retrieval put it in the prompt.

#### Move 3 — the principle

An LLM is a stateless function from tokens to tokens, sampled — not a knowledge store and not a deductive engine. Every capability you want from it (facts, memory, structure, tools) is something *you* engineer around it by controlling what tokens go in. That single reframe is why buffr is mostly plumbing: retrieval, prompts, and a loop, all in service of feeding one forgetful function the right tokens.

## Primary diagram

```
  The LLM as a function, in full — buffr's call path

  ┌─ TUI ─────────┐   question (string)
  │  chat.tsx     │ ──────────────────────────────────┐
  └───────────────┘                                    ▼
  ┌─ Agent (aptkit) ───────────────────────────────────────────────┐
  │  RagQueryAgent.answer → runAgentLoop                            │
  │    assemble request {system, messages, tools}                   │
  │            │                                                    │
  │            ▼                                                    │
  │   ┌─ Provider ──────────────────────────────────────────────┐  │
  │   │ ContextWindowGuardedProvider  (size pre-check, :46)      │  │
  │   │   └─► GemmaModelProvider.complete (gemma-provider.ts:52) │  │
  │   │         └─► HTTP /api/chat → Ollama → gemma2:9b          │  │
  │   │               next-token loop → one string out           │  │
  │   └──────────────────────────────────────────────────────────┘ │
  │            │ tool call? ──► search_knowledge_base ──► pgvector   │
  │            ▼                                                    │
  │   final grounded answer (string)                               │
  └────────────────────────────────────────────────────────────────┘
   stateless · sampled · owns no truth · re-prompted every turn
```

## Elaborate

The "function from tokens to tokens" framing is the transformer-era reframe of language modeling: older models predicted the next word too, but transformers made the context (all prior tokens) cheap enough to attend over at scale. The practical fallout for an application engineer is that *context is the only input you control*. You can't reach into the weights; you can only change the prompt. That's why the next four files in this section — tokenization, sampling, structured output, and ultimately provider abstraction — are all about controlling or measuring the tokens crossing that one function boundary.

Adjacent concepts: the model's forgetfulness is what `02-context-and-prompts/` and `03-retrieval-and-rag/` exist to compensate for; its probabilistic output is what `05-evals-and-observability/` exists to measure; its statelessness is what makes `04-agents-and-tool-use/` a *loop* rather than a single call.

## Project exercises

No curriculum file present; exercises derived from the codebase. This concept is **exercised** (Case A) — `gemma2:9b` is the brain in buffr's loop.

### EX-01-1 — Prove statelessness with a two-call experiment

- **Exercise ID:** EX-01-1
- **What to build:** A throwaway script that calls `GemmaModelProvider` (via a fresh `createChatSession`) twice with a fact-bearing question, where the fact is only available via retrieval, and a second time with retrieval disabled — showing the model "forgets" between calls and only knows what's in the prompt.
- **Why it earns its place:** Makes the abstract "stateless function" claim concrete and undeniable; it's the mental model the whole repo depends on.
- **Files to touch:** a new `scripts/llm-statelessness.ts` (mirror `src/cli/ask` usage of `createChatSession`), reading `src/session.ts` for the wiring. Do not edit aptkit.
- **Done when:** running it prints the same question answered two ways and you can point at the prompt difference that caused it.
- **Estimated effort:** 1-4hr

### EX-01-2 — Surface the model identity in the trace

- **Exercise ID:** EX-01-2
- **What to build:** Confirm (and if missing, assert in a test) that every `model_usage` row written by `SupabaseTraceSink` records `provider/model` = `gemma/gemma2:9b`, so the ledger names exactly which function produced each answer.
- **Why it earns its place:** Ties the "one function" idea to observability — you can audit which model answered, the first step to ever swapping it.
- **Files to touch:** `src/supabase-trace-sink.ts:73-78` (read), a new test under the existing test dir asserting the `model` string shape.
- **Done when:** a test fails if the persisted `model` field stops being `gemma/gemma2:9b`.
- **Estimated effort:** <1hr

## Interview defense

**Q: "Is an LLM a database? If I index a document, does the model now 'know' it?"**

No. The model is stateless and owns no durable truth; the document lives in pgvector, and the model only ever sees it if retrieval pastes it into the prompt for that one call.

```
  index ≠ model-knows

  index doc ──► pgvector (agents.chunks)   ← the doc lives HERE
                     │
                     │  only on a tool call, this turn
                     ▼
  prompt ──► gemma2:9b ──► answer          ← model sees it only now
```

*Anchor:* the model has no DB read inside it — `GemmaModelProvider.complete` (`gemma-provider.ts:52`) only does an HTTP call to Ollama; the facts come from a separate hop to `pg-vector-store.ts:67`.

**Q: "Why is the same prompt able to give different answers?"**

Because output is *sampled* token-by-token from a probability distribution, not computed deterministically. Each next token is a pick from a ranking, so two runs can diverge.

```
  sampling = non-determinism

  same prompt ─► P(next token) ─► pick A ─► "the mat"
                              └─► pick B ─► "the rug"
```

*Anchor:* `stream: false` in `gemma-provider.ts:69` waits for the full sampled sequence, but it's still sampled — see `03-sampling-parameters.md` for the dials that control it.

## See also

- `02-tokenization.md` — what the "tokens" in "tokens-to-tokens" actually are.
- `03-sampling-parameters.md` — the dials on the sampling step.
- `08-provider-abstraction.md` — how buffr wraps this one function behind an interface.
- `../04-agents-and-tool-use/01-agents-vs-chains.md` — the loop that re-prompts the forgetful function.
- `../03-retrieval-and-rag/11-rag.md` — the retrieval that compensates for its forgetfulness.

# The Context Window

### *industry: the context window · type: a hard runtime constraint*

## Zoom out

Every layer in buffr eventually funnels into one fixed-size container. Here is the stack, with this concept marked.

**buffr's request path, top to bottom**

```
┌──────────────────────────────────────────────────────────────┐
│  CLI / ChatSession      ask("what did I ship in May?")         │
├──────────────────────────────────────────────────────────────┤
│  RagQueryAgent          builds the system prompt ONCE          │
├──────────────────────────────────────────────────────────────┤
│  runAgentLoop           turns: tool-call ↔ tool-result         │
├──────────────────────────────────────────────────────────────┤
│  ★ CONTEXT WINDOW ★     gemma2:9b's 8192-token budget          │  ◄── this file
│     (everything below must FIT inside this box, per call)      │
├──────────────────────────────────────────────────────────────┤
│  gemma2:9b              reads the box, emits next tokens       │
└──────────────────────────────────────────────────────────────┘
```

You spent seven years passing props into components. A render is a pure function of its props — the component sees what you gave it, nothing else. The context window is that, with a ceiling. gemma2:9b is a function of the bytes in its input, and the input has a hard maximum: **8192 tokens**. Go over, and the call doesn't degrade gracefully — in buffr it doesn't even fire. That ceiling is the single most important number in the system, so we start here.

## Structure pass

The window has layers too, and one axis decides everything: **when each layer is built.**

**The window's contents, ordered by when they're assembled**

```
            BUILT ONCE (constructor)          REBUILT EVERY TURN
            ─────────────────────────         ───────────────────────────
  cheap ◄── │ system prompt template │        │ user question           │ ──► volatile
            │ + profile (me.md)      │        │ tool results (chunks)   │
            │ + tool schemas (TEXT!) │        │ truncated @ 16,000 chars│
            └────────────────────────┘        └─────────────────────────┘
                       ▲                                  ▲
                       │                                  │
              fixed overhead, paid               the part you actually
              on every single turn               came to ask about
```

The seam is right there in the middle: **the left block is constant, the right block churns.** That matters because the left block is *not free* — it's spent out of the same 8192 budget on every turn, before your question gets a single token. The expensive surprise: gemma2:9b has **no native tool API**, so the tool schemas can't ride in a separate `tools` field the way they would with a frontier model — they get rendered into the **system prompt text**. Tool definitions are prose now. They eat the budget.

## How it works

### Move 1 — Mental model: a fixed-size buffer

The context window is a fixed-size buffer, like a `Uint8Array(8192)` you must pack by hand. There's no `realloc`. Everything the model considers — instructions, your data, the question, retrieved evidence — shares this one allocation.

**The buffer, conceptually**

```
  ┌─────────────────────────── 8192 tokens ───────────────────────────┐
  │ system prompt │ profile │ tool schemas │ question │ tool results   │
  └───────────────┴─────────┴──────────────┴──────────┴────────────────┘
   └──── fixed overhead, every turn ───────┘ └──── your actual turn ───┘
                                            ▲
                            the more the left eats, the less
                            room the right has to be useful
```

Frontend bridge: you've blown a memory budget before — a bundle that ballooned because one dependency dragged in three more. Same shape. Every token of overhead is a token your real payload can't use.

### Move 2 — Walk the assembly

**Part A — The budget is a guard, not a suggestion**

buffr wraps the raw Gemma provider in a guard that estimates the input size and refuses to call the model if it won't fit.

**Where the ceiling is set**

```
  GemmaModelProvider (raw, no limit)
            │  wrapped by
            ▼
  ContextWindowGuardedProvider ── maxTokens: 8192
            │
            │  on every complete():
            ▼
   estimate input tokens ──► fits? ──► call gemma2:9b
                              │
                              └─► no ──► throw ContextWindowExceededError
                                         (the model never runs)
```

```ts
// src/session.ts:46
const model = new ContextWindowGuardedProvider(
  new GemmaModelProvider({ host: cfg.ollamaHost }),
  { maxTokens: 8192 },                 // ◄── the entire budget, declared here
);
```

The guard reserves headroom for output, then checks `estimatedInputTokens <= availableInputTokens`. Over budget throws `ContextWindowExceededError` *before* the provider is called — you fail fast with a named error instead of getting silently-truncated garbage from Ollama. This is the difference between a checked array access and a buffer overrun.

**Part B — The system prompt is built once, then frozen**

The constant left block is literally constant: `RagQueryAgent` assembles it in its constructor and never rebuilds it.

**System-prompt assembly (happens once, at agent construction)**

```
  DEFAULT_SYSTEM_TEMPLATE ──┐
                            ├─► injectProfile(position: 'start') ──┐
  profile (me.md text) ─────┘                                     │
                                                                  ▼
                                              renderPromptTemplate(…, {})
                                                                  │
                                                                  ▼
                                                       this.system  (frozen)
```

```ts
// aptkit RagQueryAgent constructor — wired from src/session.ts:57
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});   // ◄── built ONCE, reused every turn
```

```ts
// src/session.ts:47, :57
const profile = await loadProfile(pool, cfg.appId);     // me.md from agents.profiles
const agent = new RagQueryAgent({ model, tools, profile, trace });
```

The profile (your `me.md`) is prepended *at the start* of the system prompt. Position is deliberate — and it's the exact thing the next file (`02-lost-in-the-middle.md`) is about: the start of the window is a high-attention slot. Building once is the right call: re-rendering identical text every turn would be pure waste, like recomputing a constant inside a render loop.

**Part C — Tool schemas are prose, and they're expensive**

gemma2:9b has no tool-calling API. So the `search_knowledge_base` schema can't sit in a structured `tools` channel — it's stringified into the system text.

**Where tool schemas land, frontier model vs. gemma2:9b**

```
  Frontier model (Claude, GPT)          gemma2:9b (buffr)
  ──────────────────────────            ────────────────────────────
  system: "..."                         system: "...
  tools:  [ {schema} ]  ◄ separate                + RENDERED TOOL SCHEMA
           channel, not                            as plain text"  ◄ inside
           in the prompt text                      the 8192 budget
```

```ts
// src/session.ts:43-44 — the tool whose schema becomes prose
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
```

Consequence: with a frontier model, tool definitions are nearly free against the prompt budget. With gemma2:9b they're a recurring tax on every turn. The fewer tools and the leaner each schema, the more of your 8192 stays available for actual evidence. buffr keeps exactly one tool — that's not minimalism for its own sake, it's budget discipline.

**Part D — Tool results are truncated at a hard cap**

The volatile right block can flood. A `search_knowledge_base` call returns chunks; the loop caps each result before it re-enters the window.

**Tool-result flow back into the window**

```
  search_knowledge_base ──► chunks (could be large) ──► JSON.stringify
                                                              │
                                                  truncate @ 16,000 chars
                                                              │
                                                              ▼
                                          appended as a tool_result message
                                          (…[truncated] if it was over)
```

```ts
// aptkit run-agent-loop.ts:52 — the cap buffr runs under
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

And the loop itself is bounded so the window can't grow unbounded across turns:

```ts
// aptkit RagQueryAgent.answer() — buffr's settings, src/session.ts wires the agent
maxTurns: 6,        // ◄── at most 6 model calls
maxToolCalls: 4,    // ◄── at most 4 tool invocations before forced synthesis
```

16,000 chars is a backstop, not a strategy. It prevents one fat tool result from blowing the budget, but blind tail-truncation can lop off the most relevant chunk if it sorted last — which is exactly why the *upstream* `minTopK:4` + short chunks matter more than the cap. Defense in depth: keep the result small at the source, and truncate as a last resort.

### Move 2.5 — Current vs. future

**The honest gap: no per-turn history in the prompt.**

```
  TODAY                                  WHAT'S MISSING
  ─────────────────────────             ──────────────────────────────
  answer(q1) ─► fresh window            answer(q2) does NOT see q1 in
  answer(q2) ─► fresh window            the prompt. No "as I said above."
       │                                       │
       └─ continuity comes from          ─────┘ sequential turn history
          RETRIEVAL (memory chunks),            is an aptkit-side change,
          not from stuffing transcript           not yet wired
          into the window
```

`RagQueryAgent.answer()` treats every question independently — there is no rolling transcript packed into the window (documented in `src/session.ts:25-27`). Conversation continuity is real, but it comes from **retrieval-based memory**: after each turn the exchange is embedded into the same vector store (tagged `kind=memory`) and resurfaces later via the *same* `search_knowledge_base` tool. That's a deliberate trade. Stuffing raw history into the window is the obvious thing and the wrong default here — it burns the 8192 budget on transcript and triggers exactly the position-bias problem in the next file. Retrieval gives relevance-based recall without paying that tax. Whether to *also* add a short sequential history is a genuine open design question, not an oversight.

### Move 3 — The principle

**The context window is a budget you spend, not a context you have.** Frontend taught you state is something the framework holds for you across renders. Here, nothing is held. Every turn you re-justify the cost of every token: overhead first (system + profile + schemas), then evidence, then question. The engineering is allocation under a hard cap — decide what earns its bytes, fail fast when it won't fit, and refuse to pay for things (like raw history) that retrieval can supply more cheaply.

## Primary diagram

The full picture: one turn, from question to a packed, bounded, guarded window.

**One turn through buffr's context window**

```
  ask("what did I ship in May?")
            │
            ▼
  ┌──────────────────────── ContextWindowGuardedProvider (maxTokens: 8192) ────────────────────────┐
  │                                                                                                  │
  │   BUILT ONCE (constructor)                              REBUILT THIS TURN                        │
  │   ┌────────────────────────────────┐                   ┌──────────────────────────────────┐     │
  │   │ system template                │                   │ user question                    │     │
  │   │ + profile (me.md, at START)    │                   │ tool results (chunks)            │     │
  │   │ + tool schemas (as PROSE)      │                   │   truncated @ 16,000 chars        │     │
  │   └────────────────────────────────┘                   └──────────────────────────────────┘     │
  │                                                                                                  │
  │   estimate tokens ──► fits in 8192? ──► YES ──► gemma2:9b generates                              │
  │                                  │                                                               │
  │                                  └──► NO ──► throw ContextWindowExceededError (never calls model)│
  │                                                                                                  │
  │   loop bounds:  maxTurns 6  ·  maxToolCalls 4    (window can't grow forever)                     │
  │   NOT in window: prior turns' transcript — continuity comes from retrieved memory chunks         │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

After the box: gemma2:9b emits the answer, the loop may take another turn (still inside 8192), and at turn/budget exhaustion the synthesis instruction forces a final answer with tools disabled.

## Elaborate

- **Why 8192 and not bigger?** It's gemma2:9b's practical local budget on Rein's laptop. A bigger model or a longer-context variant moves the number, but the *discipline* doesn't change — there is always a ceiling and you always pay overhead first. Code-wise it's one constant (`src/session.ts:46`); the architecture around it stays identical.
- **Token estimation is approximate.** The guard estimates input tokens by a chars-per-token heuristic, not a real tokenizer pass. That's fine for a guard — you want a cheap conservative check, and the `outputReserve` headroom absorbs the error. Don't read `ContextWindowExceededError` as a precise measurement; read it as "too close, refuse."
- **Truncation order is content-blind.** `truncate()` keeps the first 16,000 chars and drops the tail. If your store ever returns chunks in a low-value-first order, the cap throws away your best evidence. Today `minTopK:4` keeps results well under the cap, so it rarely fires — but it's a latent footgun the moment results grow. The real fix lives upstream in retrieval, not in a bigger cap.
- **The profile-at-start choice is load-bearing.** `injectProfile({ position: 'start' })` isn't cosmetic. The next file explains why the start slot is privileged. If you ever move the profile to the middle of a large window, expect the model to under-use it.

## Project exercises

### Surface the live token budget

- **Exercise ID:** [B1.1] (cite [C1.2], Phase 1) — instrumentation prerequisite for the chaining work.
- **What to build:** Read back and log the guard's per-turn estimate: estimated input tokens, the 8192 ceiling, and the percentage consumed by the fixed left block (system + profile + tool schemas) vs. the volatile right block.
- **Why it earns its place:** You cannot budget what you can't see. Today the 8192 is a config constant with no observability — you have no idea how much of it the tool-schema prose actually eats. This number drives every later decision in this sub-section.
- **Files to touch:** `src/session.ts` (wrap/extend the provider to emit the estimate), `src/supabase-trace-sink.ts` (persist it as a trace event).
- **Done when:** A trace row per turn shows `estimatedInputTokens / 8192` and the overhead-vs-payload split, and you can point at the exact percentage tool schemas cost.
- **Estimated effort:** 1–4hr.

### Make truncation content-aware

- **Exercise ID:** [B1.2] (cite [C1.2], Phase 1) — Case B: today truncation is blind tail-cut; this is the next step.
- **What to build:** Before the 16,000-char cap, sort retrieved chunks by score so truncation drops the *least* relevant tail, not whatever sorted last. (buffr currently relies on `minTopK:4` keeping results small; this hardens the path for when they aren't.)
- **Why it earns its place:** `MAX_TOOL_RESULT_CHARS` is content-blind (`aptkit run-agent-loop.ts:52`). The fix belongs in buffr's tool result assembly, where you control ordering before it re-enters the window.
- **Files to touch:** `src/pg-vector-store.ts` (`search()` already returns `score` — guarantee descending order), and verify the search tool wiring in `src/session.ts:43`.
- **Done when:** A synthetic oversized result set truncates the lowest-scoring chunks first, proven by a test that asserts the kept chunks are the top-scored ones.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "gemma2:9b has no tool API. Where do the tool schemas go, and why is that expensive?"**

Into the system prompt *text*. With a frontier model the schema rides a separate `tools` channel that doesn't count against the prompt the same way; with gemma2:9b it's stringified prose inside the 8192-token budget, paid on every turn.

```
  frontier: system + [tools]    ← schema in a side channel
  gemma2:9b: system("...+SCHEMA AS TEXT...")  ← schema eats the budget
```

Anchor: *"No native tools means tool definitions are prose, and prose costs budget."*

**Q: "Does buffr remember the previous question within a session?"**

Not by stuffing it into the window. `answer()` treats each question independently (`src/session.ts:25-27`). Continuity comes from retrieval — each exchange is embedded as a memory chunk and resurfaces via the same search tool.

```
  q1 ─► fresh window ─► answer ─► embed exchange as memory chunk
  q2 ─► fresh window ─► search_knowledge_base may RETRIEVE the q1 memory
```

Anchor: *"Continuity by retrieval, not by transcript — it saves the budget and dodges position bias."*

**Q: "What happens if the assembled input exceeds 8192 tokens?"**

The guard estimates input size and throws `ContextWindowExceededError` before calling the model — fail fast, no silent truncation by Ollama.

```
  estimate ─► over budget? ─► throw (model never runs)
                   │
                   └─ under ─► gemma2:9b generates
```

Anchor: *"It's a checked bound, not a buffer overrun."*

## See also

- `../01-llm-foundations/` — tokens, autoregressive generation, why input is a fixed-size function.
- `./02-lost-in-the-middle.md` — the failure mode *inside* a full window; why profile-at-start matters.
- `./03-prompt-chaining.md` — when one window can't hold one job, split across windows.
- `../03-retrieval-and-rag/` — retrieval is how buffr keeps the window from overflowing.
- `../04-agents-and-tool-use/` — the multi-turn view: `runAgentLoop`, `maxTurns:6`, `maxToolCalls:4`.

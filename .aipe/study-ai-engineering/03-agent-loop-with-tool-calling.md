# Agent loop with tool calling — bounded turns, forced synthesis

**Industry name(s):** Agentic RAG / tool-using agent loop (ReAct-shaped) · Language-agnostic pattern.

## Zoom out, then zoom in

When you run `ask`, you don't call retrieval then generation in a fixed order — you hand the model a tool and let *it* decide whether to search and when to answer. That's the difference between a chain and an agent. The loop sits between the CLI and the model, mediating every turn.

```
  Zoom out — where the agent loop lives

  ┌─ CLI layer ──────────────────────────────────────────────┐
  │  ask-cmd.ts → RagQueryAgent.answer(question)              │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Library layer ───────────▼──────────────────────────────┐
  │  ★ runAgentLoop ★  (maxTurns 6, maxToolCalls 4)           │ ← we are here
  │   model.complete  ⇄  tools.callTool  ⇄  forced synthesis  │
  └──────────┬────────────────────────────┬───────────────────┘
             │ generate                    │ search
  ┌─ Provider ▼─────────┐      ┌─ Tool ────▼──────────────────┐
  │  Gemma2:9b (Ollama) │      │  search_knowledge_base       │
  └─────────────────────┘      │  → query path (file 02)      │
                               └──────────────────────────────┘
```

Zoom in: the loop's job is to let the model take an unknown number of steps — think, call the search tool, read the result, maybe search again, then answer — while guaranteeing it *terminates* and *grounds*. The verdict up front: this is the hybrid — a bounded loop on the outside, model-chosen steps on the inside. The two mechanics that make it safe are the iteration budget and the forced-final synthesis turn.

## Structure pass

Three nested layers, axis held constant: **who decides control flow?**

```
  Axis traced = "who decides what happens next?"

  ┌─ outer: runAgentLoop (the for-loop) ┐  CODE decides
  │  fixed budget: maxTurns/maxToolCalls │  → bounded, deterministic
  └──────────────────┬───────────────────┘
                     │  seam ① — CODE ═╪═ MODEL (control flips here)
  ┌─ inner: each turn ──────────────────┐  MODEL decides
  │  call a tool? or answer? model picks │  → free, unpredictable count
  └──────────────────┬───────────────────┘
                     │  seam ② — MODEL ═╪═ TOOL (control flips again)
  ┌─ innermost: tools.callTool ─────────┐  TOOL runs
  │  search_knowledge_base executes      │  → deterministic, returns result
  └──────────────────────────────────────┘
```

This is the canonical agent skeleton and the contrast *is* the lesson. **Seam ①**: the outer loop's budget is code's last word — no matter what the model wants, turn 6 is the end. **Seam ②**: when the model emits a tool call, control flips to deterministic tool code, which returns a result the model then reads. The most load-bearing mechanic is the **forced-final synthesis turn**: on the last turn the loop strips the tools array, so the model *cannot* call a tool and *must* produce text. Without it, a model that keeps wanting to search would hit the budget with no answer.

## How it works

Mental model: you know a `while` loop that polls until a condition flips — `while (!done) { step(); }`? The agent loop is that, where "done" is "the model returned text with no tool call," with a hard counter so it can't spin forever.

```
  The agent loop kernel — observe / act / stop

  turn 0 ─┐
          ▼
   model.complete(system, messages, tools?)
          │
     ┌────┴─────────────────┐
     │ response has          │
     │ tool_use blocks?      │
     └────┬───────────┬──────┘
          │ yes       │ no
          ▼           ▼
   run each tool   finalText = text
   append result   break  ← termination
   to messages        │
          │           │
          └─► turn+1 ──┘  (until turn == maxTurns-1
                            OR toolCalls == maxToolCalls
                            → forceFinal: drop tools, must answer)
```

### Step 1 — the model gets one turn to think

Each iteration calls `model.complete({ system, messages, tools })`. The system prompt tells Gemma to *always search first* before answering. The model returns content blocks — either `text` (an answer or reasoning) or `tool_use` (a request to run a tool). buffr's profile is already baked into `system`. Boundary condition: the response's usage counts (`model_usage`) are emitted to the trace — but buffr's sink drops that event, so token cost isn't recorded.

### Step 2 — if it called a tool, run it and feed the result back

The loop extracts `tool_use` blocks, calls `tools.callTool(name, input)` for each, and pushes the result back as a `tool_result` message. Now the model's next turn *sees* the retrieved chunks. This is the "observation" in observe-act. Boundary condition: a thrown tool error is caught and fed back as `{ error: message }` with `isError: true` — the model reads the failure and can retry or answer around it, rather than the whole run crashing.

```
  Layers-and-hops — one tool round-trip inside the loop

  ┌─ loop ────────┐ hop 1: tool_use {query}   ┌─ tool registry ─┐
  │  reads model  │ ─────────────────────────► │  callTool       │
  │  response     │ hop 4: tool_result JSON    │  → pipeline.query│
  │               │ ◄───────────────────────── │  → chunks+cites │
  └───────────────┘                            └────────┬─────────┘
                                          hop 2 embed   │
                                          hop 3 cosine  ▼ (file 02)
```

### Step 3 — the budget and the forced synthesis turn

Two counters bound the run: `maxTurns: 6` (total iterations) and `maxToolCalls: 4` (total tool executions). When either is spent, or it's the last turn, `forceFinal` flips true and the next `model.complete` is called with `tools: undefined` plus a synthesis instruction: *"You have NO more tool calls available. Now answer directly, citing the sources."* The model physically cannot request a tool, so it must synthesize.

### Move 2 variant — the load-bearing skeleton

Strip the loop to its irreducible kernel and name each part by what breaks without it:

```
  Agent loop kernel — remove any part and it breaks

  ┌─ messages array (growing context) ──────────────────────┐
  │  drop it → model forgets prior turns, can't ground on    │
  │  the chunks it just retrieved                            │
  ├─ tool_use detection + break-on-no-tool ─────────────────┤
  │  drop it → loop never terminates on a finished answer    │
  ├─ tool result fed back as a message ─────────────────────┤
  │  drop it → model searches but never SEES the result;     │
  │  retrieval is pointless                                  │
  ├─ iteration budget (maxTurns / maxToolCalls) ────────────┤
  │  drop it → a confused model loops forever, burns tokens  │
  ├─ forced-final synthesis (drop tools on last turn) ──────┤
  │  drop it → run can hit the budget with NO answer at all  │
  └──────────────────────────────────────────────────────────┘
```

Skeleton vs hardening: the five parts above are the kernel. Hardening layered on top — the trace sink, the tool-result truncation at 16k chars, the Gemma JSON-retry nudge (`04`) — is optional. What's notably *absent* from buffr's hardening: no repeated-tool-call loop detection (a model that searches the same query 4 times just burns its budget), and no per-tool timeout.

### Move 3 — the principle

An agent is a bounded loop where the model owns step selection and code owns termination. The principle: never let the model own both the steps *and* the stopping condition — code keeps the budget and the forced final turn, so the loop always ends with an answer. "Flexible inside, bounded outside" is the whole safety story.

## Primary diagram

The full loop, every layer and the forced-final branch labeled.

```
  buffr agent loop — full recap

  question
     │
     ▼
  ┌─ runAgentLoop (maxTurns 6, maxToolCalls 4) ───────────────┐
  │                                                           │
  │  for turn in 0..6:                                        │
  │    forceFinal = (turn==last) OR (toolCalls>=4)            │
  │    resp = model.complete(                                 │
  │      system + (forceFinal ? synthesisInstruction : ''),   │
  │      messages,                                            │
  │      tools = forceFinal ? undefined : toolSchemas)        │
  │         │                                                 │
  │    ┌────┴── has tool_use? ──┐                             │
  │    │ yes                    │ no                          │
  │    ▼                        ▼                             │
  │  callTool → push result   finalText = text → BREAK        │
  │  (search_knowledge_base)                                  │
  │         └── loop ───────────────────────────────────────►│
  └───────────────────────────────────────────────────────────┘
     │
     ▼  finalText.trim() || "I couldn't find anything..."
   answer (+ trace persisted to agents.messages)
```

## Implementation in codebase

**Use cases.** Every `ask` invocation. The agent decides: search the personal corpus, read the chunks, answer with citations — or, if nothing's relevant, say so plainly. buffr wires the model, the tool registry, the profile, and the trace sink; the library runs the loop.

**Code side by side.**

```
  src/cli/ask-cmd.ts  (lines 23–34)

  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry(
    [tool.definition], { [tool.definition.name]: tool.handler });  ← register the one tool
  const model = new ContextWindowGuardedProvider(
    new GemmaModelProvider({ host: cfg.ollamaHost }), { maxTokens: 8192 }); ← window cap
  const profile = await loadProfile(pool, cfg.appId);              ← me.md (file 07)
  const trace = new SupabaseTraceSink({ pool, conversationId });   ← trajectory capture
  const agent = new RagQueryAgent({ model, tools, profile, trace });
  const answer = await agent.answer(question);                     ← run the loop
       │
       └─ buffr supplies four things; the loop logic is all library. The
          decision to bound generation with a context guard is buffr's call
```

The loop body itself lives in the library (`runAgentLoop`), which buffr does not edit. The buffr-side decisions that shape it: which model, which tool, the 8192-token guard, and the trace sink that captures the trajectory.

```
  library: RagQueryAgent.answer — the budget buffr inherits

  maxTurns: 6,
  maxToolCalls: 4,
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources...')
       │
       └─ 6 turns but only 4 tool calls — so the model always has ≥1 turn left
          to synthesize after exhausting its searches (the budget is asymmetric
          on purpose)
```

## Elaborate

The loop is a lightweight ReAct: observe (tool result) → act (next tool or answer). It's missing the explicit verbalized "Thought:" step of textbook ReAct, so the model's reasoning is implicit rather than externalized — which makes a bad run harder to debug from the trace. The bounded-budget-plus-forced-synthesis shape is the production-hardened version of the naive `while (!done)` agent; the budget is what stops the "agent loops forever burning tokens" failure the spec's error-recovery table calls out.

The deeper agent-architecture treatment — reasoning patterns, multi-tool routing, agentic retrieval — lives in `.aipe/study-agent-architecture/` if that generator is run. This file covers the loop as an *AI-engineering* concern: bounded turns, grounded synthesis, tool-result feedback.

What to read next: `04-gemma-tool-call-emulation.md` — the inner seam where the model's tool call is actually a parsed JSON string, because Gemma has no native tools. That's where this loop is most likely to break.

## Project exercises

> No `aieng-curriculum.md` present; exercises name the buildable target directly.

### Add repeated-tool-call loop detection

- **What to build:** Detect when the model issues the same `search_knowledge_base` query twice and inject a "try a different approach" message instead of re-running it.
- **Why it earns its place:** Closes a named gap in error recovery — "my agent detects when it's stuck and breaks the loop" is concrete agent-craft signal.
- **Files to touch:** Since the loop is in the library (not editable), wrap it: add a buffr-side `LoopGuardTool` decorator around the search tool's handler in `src/cli/ask-cmd.ts`, or a thin wrapping registry that tracks recent args.
- **Done when:** a test where the model repeats a query gets a redirect on the second identical call rather than a duplicate search.
- **Estimated effort:** 1–4hr.

### Capture token/cost per turn

- **What to build:** Handle the `model_usage` trace event in `SupabaseTraceSink` and write `tokens_used` into `agents.messages`.
- **Why it earns its place:** The column and the event already exist and are both unused — wiring them is the cheapest observability win and shows you can find the slow/expensive link.
- **Files to touch:** `src/supabase-trace-sink.ts` (handle `model_usage`), `sql/001_agents_schema.sql` (already has `tokens_used`).
- **Done when:** an `ask` run populates `tokens_used` for assistant messages.
- **Estimated effort:** <1hr.

## Interview defense

**Q: Is this an agent or a chain? Defend it.**

```
  outer: for-loop (CODE bounds turns) ── inner: model picks tool-or-answer (MODEL)
  control flips at the seam → it's an agent
```

"It's an agent: the model decides whether to search and how many times, within a code-enforced budget. A chain would have a fixed retrieve-then-generate order; here the step count is unknown until the model stops." Anchor: control flips from code to model at the loop boundary.

**Q: What's the one mechanic people forget?**

The forced-final synthesis turn. "On the last turn the loop drops the tools array, so the model physically can't call a tool and must answer. Without it, a model that keeps wanting to search hits the budget with no answer at all. Everyone shows me the happy-path loop and forgets the termination guarantee." Anchor: code owns the stopping condition, never the model.

## Validate

- **Reconstruct:** Draw the loop kernel from memory: the turn, the tool-use branch, the break, the budget, the forced-final turn. (library `runAgentLoop`; budget set in `RagQueryAgent`)
- **Explain:** Why is `maxTurns: 6` larger than `maxToolCalls: 4`? What would break if they were equal? (`RagQueryAgent.answer`)
- **Apply:** A user reports `ask` sometimes returns "I couldn't find anything..." even though the corpus has the answer. Walk the loop and name two places this could originate. (`src/cli/ask-cmd.ts:23` minTopK; `04` JSON parse failure)
- **Defend:** buffr wraps Gemma in `ContextWindowGuardedProvider(maxTokens: 8192)`. Defend that choice given the loop appends tool results to `messages` every turn. (`src/cli/ask-cmd.ts:26`)

## See also

- `04-gemma-tool-call-emulation.md` — how a tool call survives a model with no native tool API.
- `02-rag-query-path.md` — what the search tool actually runs.
- `07-profile-as-context.md` — how the profile reaches the loop's system prompt.
- `.aipe/study-system-design/03-trajectory-capture.md` — the trace sink that records the loop's turns.
- `.aipe/study-agent-architecture/` — the reasoning-pattern view of the same loop (if generated).

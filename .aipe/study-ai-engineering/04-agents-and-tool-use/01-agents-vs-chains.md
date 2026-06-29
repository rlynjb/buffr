# Agents vs Chains
### *The control axis: who decides the next step — your code or the model?*
**Type label:** control-flow pattern (orchestration)

## Zoom out

Before we name anything, look at where this decision lives in the stack. Every LLM application has to answer one question: *who picks the next step?* That answer is a layer, and it sits between the model and the tools.

```
The orchestration layers in buffr
┌───────────────────────────────────────────────────────────┐
│  Application      session.ask(question) → answer            │  fixed: persist, run, flush, remember
├───────────────────────────────────────────────────────────┤
│  ★ ORCHESTRATION  agent vs chain — WHO decides next step?   │  ← this file
│                   runAgentLoop / RagQueryAgent              │
├───────────────────────────────────────────────────────────┤
│  Model            model.complete({messages, tools})         │  one forward pass
├───────────────────────────────────────────────────────────┤
│  Tools            search_knowledge_base → pgvector          │  deterministic
└───────────────────────────────────────────────────────────┘
```

The orchestration layer (★) is the only one with a *choice* about flow. The model is a pure function of its input; the tool is deterministic; the application is a fixed script. Everything interesting about "is this an agent?" happens in that one band.

Here's the conversational version. You came from frontend. You already know the two shapes of control flow — you've written both. A **chain** is a `.then().then().then()` promise pipeline: the steps are written down in advance, in order, by you. An **agent** is an event loop with a `while` and a `switch`: the loop runs, something inside *decides* what happens next, and you don't know the sequence until runtime. The question this file answers is which one buffr is. The honest answer is: both, and the seam between them is the whole point.

## Structure pass

There's exactly one axis that separates a chain from an agent, and it's worth stating precisely because the whole industry blurs it: **who decides the next step.**

```
The control axis (the one that matters)
   CODE DECIDES                                    LLM DECIDES
   (fixed, you wrote it)                           (dynamic, runtime)
   ├─────────────────────────────────────────────────────────────┤
   chain                          hybrid                     pure agent
   prompt→parse→done       fixed outside, loop inside     loop all the way down
                                    ▲
                                    │
                              buffr lives HERE
```

A **chain** puts the decision in your code: step 1 runs, then step 2, then step 3, always, regardless of content. A **pure agent** puts the decision in the model: the model emits a tool call, you run it, you feed the result back, the model decides again — for as long as it wants. buffr is the **hybrid**, and the seam where control flips is the heart of the design:

```
Where control flips in buffr
  ┌──────────────────────────────────────────────────────────┐
  │  OUTER: code decides   (session.ask, RagQueryAgent.answer)│
  │  ┌────────────────────────────────────────────────────┐  │
  │  │  INNER: LLM decides   (runAgentLoop: tool? or done?)│  │  ← the flip
  │  │  ┌──────────────────────────────────────────────┐  │  │
  │  │  │  TOOL: deterministic  (search_knowledge_base)│  │  │
  │  │  └──────────────────────────────────────────────┘  │  │
  │  └────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────┘
```

The flip is at the inner boundary: outside the loop, your code is in charge (build agent once, persist turn, run, flush, remember); inside the loop, the model is in charge (call a tool or stop). The tool below is deterministic again. Control hands off, then hands back.

## How it works

### Move 1 — the mental model

The kernel is a loop with a model in the condition. That's it. A chain has no loop; an agent's loop has the model deciding when to break.

```
The agent loop in one frame
  messages = [user question]
  ┌──────── for turn in 0..maxTurns ───────────────────────┐
  │  response = model.complete(messages, tools)             │
  │  does response contain a tool_use block?                │
  │     NO  → finalText = text; BREAK ───────────────► done │
  │     YES → run each tool, push result, loop again        │
  └─────────────────────────────────────────────────────────┘
```

The model decides the exit. If it emits prose, the loop breaks and that prose is the answer. If it emits a tool call, the loop runs the tool and goes around again. Your code never decides "now we're done" — it only decides "you may go around at most `maxTurns` times."

### Move 2 — step by step

#### The outer shell: code decides the boundaries (`RagQueryAgent.answer`)

Bridge from what you know: this is the parent component that owns the `<AgentLoop/>`'s props. It doesn't render the loop's internals; it sets the budget and hands over control. In React terms, the outer shell is a controlled wrapper that configures a child it doesn't micromanage.

```
The outer shell sets the rules, then hands off
  RagQueryAgent.answer(question)
    │  filter tools to policy   ─────►  [search_knowledge_base]  (least privilege)
    │  set maxTurns: 6, maxToolCalls: 4
    │  set synthesisInstruction
    └─►  runAgentLoop(...)  ──── control flips to the model ────►
                                 finalText.trim() || FALLBACK_ANSWER
```

Real code, `aptkit packages/agents/rag-query/src/rag-query-agent.ts:62`:

```ts
async answer(question: string, runOptions: RagQueryRunOptions = {}): Promise<string> {
  const allTools = await this.options.tools.listTools();
  const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);   // ← code decides: ONE tool allowed

  const { finalText } = await runAgentLoop({
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    model: this.options.model,
    tools: this.options.tools,
    system: this.system,
    userPrompt: question,
    toolSchemas,
    maxTurns: 6,          // ← code decides: at most 6 turns
    maxToolCalls: 4,      // ← code decides: at most 4 tool calls
    synthesisInstruction: buildSynthesisInstruction(
      'Now answer the question directly and concisely, citing the sources you retrieved.',
    ),
  });

  return finalText.trim() || FALLBACK_ANSWER;   // ← code decides: never return empty
}
```

The consequence of each line being code-decided: the model can never run forever, can never see a tool it isn't policy-allowed (`ragQueryToolPolicy.allowedTools = [search_knowledge_base]`), and can never return an empty string to the user. Those are *guardrails*, and they exist precisely because the inner loop is not trusted to set its own limits.

#### The inner loop: the LLM decides each step (`runAgentLoop`)

Bridge: this is the event loop. You've written `while (running) { const event = await next(); dispatch(event); }`. Same shape. `model.complete` is `await next()`; "does it have a tool_use block" is the `dispatch`; the budget is the kill switch.

```
One turn of the inner loop
  ┌─ turn ────────────────────────────────────────────────┐
  │  forceFinal = lastTurn OR budget spent                  │
  │  response = model.complete(messages, forceFinal?none:tools)
  │  push assistant content                                 │
  │  toolUses = tool_use blocks in response                 │
  │     empty?  → finalText = text; BREAK                    │
  │     else    → for each: callTool, push tool_result      │
  │              push {role:user, content: toolResults}      │
  └────────────────────────────────────────────────────────┘
```

#### LOAD-BEARING SKELETON — the agent loop

This is the kernel every other file in this section leans on. Memorize this shape; the rest is detail. Real code, `aptkit packages/runtime/src/run-agent-loop.ts:98`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];   // ← short-term memory: this array
const toolCalls: ToolCallRecord[] = [];
let finalText = '';

for (let turn = 0; turn < maxTurns; turn += 1) {            // ← HARD STOP: turn budget
  signal?.throwIfAborted();                                 // ← cancellation seam

  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;  // ← THE GATHER→SYNTHESIZE GATE

  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,             // ← forceFinal STRIPS the tools
    maxTokens,
    signal,
  });

  messages.push({ role: 'assistant', content: response.content });

  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) {                              // ← LLM DECIDES: no tool → done
    finalText = textFromContent(response.content);
    break;
  }

  const toolResults: ModelToolResultBlock[] = [];
  for (const toolUse of toolUses) {
    try {
      const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
      // ...record result, push tool_result (truncated to 16k chars)...
    } catch (error) {
      // ...record error, push tool_result with isError: true...  ← recovery seam (see 06)
    }
  }
  messages.push({ role: 'user', content: toolResults });    // ← observation fed back as next input
}
```

The four load-bearing parts, named so you don't forget them:
- **`for (turn < maxTurns)`** — the hard iteration cap. Without it, a model that keeps emitting tool calls runs forever.
- **`forceFinal`** — the gather→synthesize gate (`03-react-pattern.md`). When the budget is spent, the *next* call gets no tools, so the model *must* answer.
- **`if (toolUses.length === 0) break`** — the only natural exit. The model decides the loop is over by speaking prose.
- **`messages.push(toolResults)`** — the observation. The tool's output becomes the model's next input. This is the entire feedback mechanism.

### Move 3 — the principle

A chain trades flexibility for predictability; an agent trades predictability for flexibility. The hybrid buys back predictability by *bounding* the agent: the LLM gets to decide *what* and *when*, but your code decides *how many times* and *which tools exist*. buffr is an agent you can reason about precisely because the outer shell refuses to let the inner loop be unbounded.

## Primary diagram

The whole thing, end to end — one frontend `ask()` through the hybrid and back.

```
buffr's hybrid control flow, one question end to end
  session.ask("what did I read about X?")          [CODE]
    │ persist user turn
    ▼
  RagQueryAgent.answer(question)                    [CODE] sets budget, filters tools
    │
    ▼
  runAgentLoop — for turn 0..5                       ── control flips ──►
    ┌──────────────────────────────────────────────────────────┐
    │ turn 0:  model.complete(msgs, tools)            [LLM]      │
    │          → emits {"tool":"search_knowledge_base"...}       │
    │          → callTool → pgvector                  [TOOL]     │  ◄ deterministic
    │          → push results as observation                     │
    │ turn 1:  model.complete(msgs, tools)            [LLM]      │
    │          → emits prose answer (no tool)                    │
    │          → BREAK, finalText = answer                       │
    └──────────────────────────────────────────────────────────┘
    │                                               ◄── control returns ──
    ▼
  finalText.trim() || FALLBACK_ANSWER               [CODE]
    │ flush trace, best-effort remember
    ▼
  answer to user
```

## Elaborate

The reason this hybrid is the right call for buffr — not a compromise — is the model. `gemma2:9b` is small and local. A pure agent with this model would wander: emit a tool call, get results, emit another nearly-identical tool call, never converge. The bound (`maxTurns: 6`, `maxToolCalls: 4`) isn't a limitation grafted onto a weak model; it's the design that makes a weak model usable. A frontier model could tolerate a looser leash. buffr's leash is short on purpose.

The other thing worth internalizing: the messages array *is* the agent's working memory, and it lives entirely inside one `runAgentLoop` call. When `answer()` returns, that array is gone. There is no conversation history carried into the next `answer()` (`05-agent-memory.md`). The agent is stateful within a question and stateless across questions. That's a real architectural fact, not an oversight — and where you'd change it.

## Project exercises

### Make the budget configurable and observable

- **Exercise ID:** [B4.1], Phase 4.
- **What to build:** Lift `maxTurns` and `maxToolCalls` out of the hardcoded `answer()` call into `RagQueryAgentOptions`, defaulting to the current 6/4. Emit a trace event when `forceFinal` first flips so the budget exhaustion is visible in the trajectory.
- **Why it earns its place:** The budget is the single most important guardrail in the hybrid, and right now it's invisible and unconfigurable. Making it a typed option forces you to understand *why* 6 and 4 were chosen, and the trace event lets you see how often real questions hit the ceiling.
- **Files to touch:** `aptkit packages/agents/rag-query/src/rag-query-agent.ts`, `aptkit packages/runtime/src/run-agent-loop.ts` (add a `budget_exhausted` trace emit), `buffr src/session.ts` (pass the option through).
- **Done when:** `answer()` accepts `{ maxTurns?, maxToolCalls? }`, defaults match today's behavior, and a question that spends the tool budget produces a visible trace event in `SupabaseTraceSink`.
- **Estimated effort:** 1–2 hours.

### Add loop detection for repeated identical tool calls

- **Exercise ID:** [B4.2], Phase 4.
- **What to build:** Inside `runAgentLoop`, hash each `(toolName, input)` pair; if the same pair repeats, force `forceFinal` early instead of burning the remaining budget on a duplicate search.
- **Why it earns its place:** A small local model's most common failure is re-issuing the *same* query and expecting a different answer. The hybrid's budget catches it eventually, but wastes turns. Detecting the duplicate converts wasted turns into an immediate synthesize.
- **Files to touch:** `aptkit packages/runtime/src/run-agent-loop.ts`.
- **Done when:** A model that emits the identical `search_knowledge_base` call twice triggers forced synthesis on the second, with a trace event recording the short-circuit. Covered by a unit test feeding a scripted duplicate.
- **Estimated effort:** 2–3 hours.

## Interview defense

**Q: "Is buffr an agent or a chain?"**

Neither, exactly — it's a bounded hybrid. The outer shell is a chain: `session.ask` does persist → run → flush → remember in fixed order, every time. The inner shell is an agent: `runAgentLoop` lets the model decide, turn by turn, whether to call a tool or answer. The seam is `runAgentLoop`'s entry: control flips from my code to the model there and flips back when the loop returns.

```
   chain shell  ──►  [ agent loop ]  ──►  chain shell
   (fixed)            (LLM-decided)        (fixed)
```

*Anchor: outside the loop my code decides how many turns; inside, the model decides each turn.*

**Q: "What stops the agent looping forever?"** — the part people forget.

Two hard stops, both in `runAgentLoop`. The `for (turn < maxTurns)` cap (6) bounds *iterations*; the `maxToolCalls` check (4) bounds *tool spend*. Whichever trips first sets `forceFinal`, which strips the tools from the next `model.complete` call — so the model physically cannot call a tool and is forced to answer. The load-bearing part people forget is that `forceFinal` doesn't just *ask* the model to stop; it *removes the tools*, so stopping is the only option.

```
  budget spent → forceFinal = true → model.complete(tools: undefined) → must answer
```

*Anchor: the budget doesn't ask the model to stop — it takes the tools away.*

## See also

- **`02-tool-calling.md`** — what happens inside `model.complete` when tools are present (the emulated path) and why there's no arg validation.
- **`03-react-pattern.md`** — `forceFinal` and `buildSynthesisInstruction` as the gather→synthesize structure.
- **`06-error-recovery.md`** — the try/catch around `callTool` and the hard stops as a recovery table.
- **`../03-retrieval-and-rag/`** — what `search_knowledge_base` does once the loop calls it.

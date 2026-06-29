# Agents vs Chains — the bounded loop

*Industry standard. buffr's `RagQueryAgent` is the agent side, bounded.*

## Zoom out, then zoom in

Here's the whole control story of buffr in one frame. The question is: who decides what happens next — your code, or the model?

```
  Zoom out — where the control decision lives

  ┌─ Session ───────────────────────────────────────────────────┐
  │  src/session.ts — fixed wrapper: persist → run → remember    │  ← CODE decides
  └───────────────────────────┬─────────────────────────────────┘
                              │  agent.answer(question)
  ┌─ Agent loop (aptkit) ─────▼─────────────────────────────────┐
  │  ★ runAgentLoop — LLM decides: call tool again, or answer ★  │  ← LLM decides  ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │  callTool(name, args)
  ┌─ Tool ────────────────────▼─────────────────────────────────┐
  │  search_knowledge_base — just runs                          │  ← TOOL runs
  └─────────────────────────────────────────────────────────────┘
```

The verdict first: buffr is a **hybrid** — a fixed pipeline *outside* (session always does persist → run → remember in that order) wrapping a *loop inside* (the agent freely decides how many times to retrieve). That nesting is the thing to understand. The session is a chain; the agent is an agent; they compose.

## Structure pass

**Layers:** session (fixed order) → agent loop (variable iterations) → tool (deterministic).

**Axis — "who decides control flow?" — traced down the layers:**

```
  one question, held constant down the layers

  ┌───────────────────────────────┐
  │ session: persist→run→remember │   → CODE decides (always this order)
  └───────────────────────────────┘
      ┌─────────────────────────────┐
      │ agent loop: retrieve? again?│   → LLM decides (per turn, up to 6)
      └─────────────────────────────┘
          ┌─────────────────────────┐
          │ tool: embed+ANN search  │   → TOOL runs (no choices)
          └─────────────────────────┘

  the answer flips at each altitude — that contrast IS the lesson
```

**The seam:** session→agent is where control flips from code to model. The session can't predict how many model turns a question needs; it just calls `agent.answer()` and waits. That's the definition of an agent: unpredictable step count, decided by the model.

## How it works

### Move 1 — the mental model

A chain is a `Promise` chain you wrote: `summarize().then(caption).then(post)` — you fixed the steps. An agent is a `while` loop where the *model* writes the loop body each iteration: it looks at what it has, decides "I need to search again" or "I can answer now," and you keep looping until it stops or you cut it off.

```
  the agent loop kernel

  ┌─────────┐  decide
  │ Thought │ ─────────► call tool? ── yes ──┐
  └─────────┘                                 ▼
       ▲                              ┌──────────────┐
       │ observe result               │ Action       │ run tool
       └──────────────────────────────│ Observation  │◄─┘
                                       └──────┬───────┘
                                  no tool-call │
                                              ▼
                                          final answer

  guardrail: hard stop at maxTurns / maxToolCalls (never trust the model to stop)
```

The load-bearing part — the one people forget — is the **hard iteration budget**. The model is not trusted to terminate. If it never emits a final answer, the loop must stop anyway.

### Move 2 — the step-by-step walkthrough

**Step 1 — buffr constructs the agent once, with model, tools, profile, trace.** The session builds it a single time and reuses it across every turn.

```ts
// src/session.ts:57
const agent = new RagQueryAgent({ model, tools, profile, trace });
```

**Step 2 — `answer()` delegates to the bounded loop with explicit budgets.** This is where the limits live. aptkit's `RagQueryAgent.answer()` calls `runAgentLoop` with hard caps and a synthesis instruction.

```ts
// aptkit packages/agents/rag-query/src/rag-query-agent.ts:62-83 (answer)
const { finalText } = await runAgentLoop({
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  model: this.options.model,
  tools: this.options.tools,
  system: this.system,                 // profile already injected at construction
  userPrompt: question,
  toolSchemas,
  trace: this.options.trace,
  maxTurns: 6,                         // ← hard turn cap
  maxToolCalls: 4,                     // ← hard tool-call cap
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
```

**Step 3 — the loop body: complete, check for a tool-call, run it or stop.** Inside `runAgentLoop`, each turn computes whether this is the forced-final turn, then completes.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:98-135 (condensed)
for (let turn = 0; turn < maxTurns; turn += 1) {
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;          // ← the hard stop
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    tools: forceFinal ? undefined : toolSchemas,                    // ← no tools on final turn
    ...
  });
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) { finalText = text; break; }           // ← model chose to answer
  // ... else run each tool, feed results back, loop
}
```

The **forced-synthesis turn** is the most important and most surprising mechanic. When the budget is spent (or it's the last turn), the loop strips the tools and appends "You have NO more tool calls available. Now answer..." This forces the model to produce an answer instead of looping forever trying to retrieve. The tradeoff it buys: bounded latency and guaranteed termination, at the cost of sometimes answering with imperfect context.

```ts
// aptkit packages/runtime/src/run-agent-loop.ts:72-74
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

**Step 4 — the session wraps the loop in fixed order.** Back out at buffr's layer, the agent loop is one step in an unchanging sequence.

```ts
// src/session.ts:60-71 (the fixed outer chain)
await persistMessage(pool, conversationId, 'user', question);  // 1. always first
const answer = await agent.answer(question);                   // 2. the loop (variable inside)
await trace.flush();                                           // 3. always
try { await memory.remember({ conversationId, question, answer }); } catch {} // 4. best-effort
return answer;
```

```
  Layers-and-hops — one buffr turn

  ┌─ Session ────┐ hop1: agent.answer(q)  ┌─ Loop ──────────┐ hop2: complete  ┌─ Model ──┐
  │ persist→...  │ ──────────────────────►│ turn 0..6       │ ───────────────►│ gemma2:9b│
  │ →remember    │ hop4: finalText ◄──────│ tool? or stop   │ hop3: tool-call ◄── └────────┘
  └──────────────┘                        │ run tool ───────┼──► search_knowledge_base
                                          └─────────────────┘
```

### Move 2 variant — the load-bearing skeleton

The irreducible kernel of buffr's agent: **model.complete → check for tool-call → (run tool, append result, loop) OR (stop) + a hard turn/tool budget that forces termination.**

- Drop the **tool-call check** → the loop can't tell "keep going" from "done"; it never terminates correctly.
- Drop the **budget / forceFinal** → a model that loops on the tool burns turns forever (or until the provider errors). This is the part interview candidates omit.
- Drop the **synthesis instruction** → at the budget cap the model still tries to call a tool that isn't there, producing a non-answer.

Optional hardening on top: the trace sink (observability, not correctness), the context-window guard (skips a turn that would overflow). Skeleton vs hardening — saying which is which is the lesson.

### Move 3 — the principle

An agent trades predictability for flexibility. The moment you let the model decide the steps, you must also decide what happens when it never decides to stop. Every production agent loop is "model freedom inside, hard budget outside." buffr's is `maxTurns=6, maxToolCalls=4`.

## Primary diagram

```
  buffr RagQueryAgent.answer() — full loop

  question ─► system (profile injected) ─┐
                                         ▼
  ┌─ for turn 0..5 ──────────────────────────────────────────┐
  │  budgetSpent = toolCalls >= 4                              │
  │  forceFinal  = (turn == 5) || budgetSpent                 │
  │       │                                                    │
  │       ▼                                                    │
  │  model.complete(system [+synthesis if forceFinal],         │
  │                 tools = forceFinal ? none : [search])      │
  │       │                                                    │
  │   ┌───┴────────────┐                                       │
  │   ▼ tool-call?      ▼ no tool-call                         │
  │  run search_kb    finalText = text ; break                 │
  │  append result                                             │
  │  toolCalls++                                               │
  └────────────────────────────────────────────────────────────┘
       │
       ▼
   answer  ─► (session: trace.flush + memory.remember)
```

## Elaborate

The agent/chain distinction comes from the ReAct line of work (`03-react-pattern.md`): instead of a fixed prompt template, the model interleaves reasoning and tool use. aptkit's `runAgentLoop` is a minimal, bounded ReAct executor. buffr is the simplest useful instance — one tool, so the "routing" decision is binary (retrieve or answer). That simplicity is why buffr is a clean place to *see* the loop without multi-agent noise. Scaling up would mean more tools (then `04-tool-routing.md` matters) or a planner/sub-agent split (then `study-agent-architecture` matters).

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Surface turn-count and tool-call-count to the trace

- **Exercise ID:** AGENT-1 (Case A — loop implemented; observability next step).
- **What to build:** persist per-answer `turns_used` and `tool_calls_used` so you can see how close real questions run to the budget.
- **Why it earns its place:** "I measured how often the loop hits its cap" is concrete evidence you understand the budget tradeoff.
- **Files to touch:** `src/supabase-trace-sink.ts` (aggregate from events), `src/session.ts`, possibly a new `messages` column or a summary row.
- **Done when:** each conversation row records how many turns and tool-calls it used.
- **Estimated effort:** 1–4hr.

### Add a second tool to force a routing decision

- **Exercise ID:** AGENT-2 (Case B — routing not yet exercised).
- **What to build:** add a `list_documents` tool so the model must choose between listing and searching, exercising `04-tool-routing.md`.
- **Why it earns its place:** a single-tool agent never demonstrates routing; two tools make the LLM-routing pattern real and testable.
- **Files to touch:** new tool definition + handler, registered in `src/session.ts:44` (`InMemoryToolRegistry`).
- **Done when:** an eval shows the model picking the right tool for "list everything" vs "what does X say".
- **Estimated effort:** 1–2 days.

## Interview defense

**Q: Is buffr an agent or a chain?**
Answer: both, nested. The session is a chain — persist, run, remember, always that order. The agent inside is a true loop: the model decides whether to retrieve again, up to `maxTurns=6` and `maxToolCalls=4`. Verdict first: "hybrid, pipeline outside, loop inside."

**Q: How does the loop terminate if the model keeps calling the tool?**
Answer: it can't loop forever — `forceFinal = turn == maxTurns-1 || toolCalls >= maxToolCalls` strips the tools and injects a synthesis instruction ("no more tool calls, answer now"). **The load-bearing part people forget is the hard budget**; without it an agent that loops on its tool burns until the provider errors.

```
  the budget sketch:  turn==5 OR toolCalls>=4  →  drop tools + "answer now"
```

## See also

- `02-tool-calling.md` — the contract the loop runs, and where it's fragile.
- `06-error-recovery.md` — the budget hard-stop as a recovery mechanism.
- `05-agent-memory.md` — what the loop remembers between sessions.
- `.aipe/study-agent-architecture/` — deeper reasoning and orchestration.

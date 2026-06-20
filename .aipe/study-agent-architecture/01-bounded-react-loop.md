# Bounded ReAct loop with forced synthesis

**Industry name(s):** ReAct (Reason + Act) agent loop with an iteration
budget and a forced final-answer turn · *Industry standard*

---

## Zoom out, then zoom in

Here's the whole thing. Everything buffr does as an "agent" happens inside one
box — the loop in aptkit's `runAgentLoop`. buffr wires the inputs and persists
the outputs; the loop itself is the agent.

```
  Zoom out — where the loop lives

  ┌─ CLI layer (buffr) ───────────────────────────────────────┐
  │  src/cli/ask-cmd.ts  →  new RagQueryAgent(...).answer(q)   │
  └───────────────────────────────┬───────────────────────────┘
                                  │  agent.answer(question)
  ┌─ Agent layer (aptkit) ────────▼───────────────────────────┐
  │  RagQueryAgent  →  ★ runAgentLoop ★   ← we are here        │
  │     reason → act → observe → … → forced synthesis          │
  └───────────────────────────────┬───────────────────────────┘
                                  │  model.complete · tools.callTool
  ┌─ Provider / Tools ────────────▼───────────────────────────┐
  │  Gemma (Ollama)        search_knowledge_base → pgvector    │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this is **ReAct** — the model reasons, picks an action, sees the
result, and reasons again, looping until it answers. The twist that makes it
*shippable* instead of a token bonfire is the **budget**: a hard turn cap, a
hard tool-call cap, and a final turn where the tools are taken away so the model
*must* produce an answer. That forced-synthesis turn is the single most
important mechanic in the codebase.

---

## Structure pass

Three nested control levels, one axis traced across all three.

**Axis: who decides what happens next?**

```
  "who decides the next move?" — traced down the stack

  ┌──────────────────────────────────────────┐
  │ outer: ask-cmd.ts (CLI)                   │  → CODE decides
  │   one question in, one answer out, once   │    (no loop here)
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ middle: runAgentLoop (the loop)       │  → the BUDGET decides
      │   keep looping until done or capped    │    when to stop
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ inner: each turn's model.complete │  → the MODEL decides
          │   tool call? or final prose?       │    the action
          └──────────────────────────────────┘
```

**The seam that matters:** the boundary between "model decides" and "budget
decides." For turns 0…N-2 the model is free — it can call the tool or answer.
At the budget edge the control *flips*: the harness removes the tools and the
model is forced to answer. That flip is the load-bearing joint. Study it before
anything else.

**Layers:** CLI (no loop) → loop (budget-governed) → turn (model-governed) →
tool call (deterministic). Mechanics hang off the middle two.

---

## How it works

### Move 1 — the mental model

You know how a `while` loop with a guaranteed exit condition is safe, but a
`while (true)` that depends on the body to `break` can hang forever? An agent
loop is exactly that risk: the body is an LLM, and *nothing guarantees the LLM
ever decides to stop*. The fix is to make the loop's exit independent of the
model's cooperation.

```
  The pattern — ReAct with a budget exit

   ┌──────────────┐
   │  reason      │  model.complete(messages, tools)
   └──────┬───────┘
          │ tool_use?
     ┌────┴────┐
     │ yes     │ no ─────────────► success exit (return prose)
     ▼         
   ┌──────────────┐
   │  act         │  run the tool
   └──────┬───────┘
          ▼
   ┌──────────────┐
   │  observe     │  push result into messages (accumulate)
   └──────┬───────┘
          │  budget spent OR last turn?
     ┌────┴────┐
     │ yes     │ no ──────────────► loop back to reason
     ▼
   strip tools + "no more calls" → FORCED synthesis → return
```

Two exits. The success exit (model stops on its own) is obvious. The budget
exit is the one that earns the loop its place in production.

### Move 2 — the skeleton, part by part

This is the load-bearing-skeleton treatment. Four parts; each named by what
breaks when it's missing.

**State — the `messages` array.** Bridge: it's the same idea as accumulating
into an array across iterations instead of recomputing from scratch. Each turn
appends the assistant's reply and then the tool results, so turn N+1 sees
everything turn N learned.

```
  messages accumulate — this is what makes it a loop

  turn 0:  [ user:Q ]
  turn 0:  [ user:Q, assistant:(tool_use search) ]
  turn 0:  [ user:Q, assistant:(tool_use), user:(tool_result chunks) ]
  turn 1:  reason over ALL of the above → next move
```

What breaks without it: every turn is amnesiac. You'd have N independent
single calls, not an agent. State is what makes it a loop.

**Step — the single `model.complete` call.** This is the only "smart" part;
everything else is plumbing. The model reads the accumulated messages and emits
either prose (it's done) or a tool-use block (it wants to act). What breaks
without it: nothing chooses the next action.

**Execute — the harness runs the tool, not the model.** The model emits
*intent* (a `tool_use` block naming the tool and args). The harness looks the
tool up and runs it, then feeds the result back as a `tool_result`. The model
never touches the tool directly.

```
  Layers-and-hops — intent emitted, harness executes

  ┌─ model ──────┐ hop 1: tool_use{search, {query}}  ┌─ harness ────┐
  │  Gemma       │ ────────────────────────────────► │ runAgentLoop │
  └──────────────┘ hop 4: tool_result chunks ◄─────── └──────┬───────┘
                                                       hop 2  │ callTool
                                                              ▼
                                                       ┌─ tool ───────┐
                                                       │ search → pg  │
                                                       └──────────────┘
                                                       hop 3: ranked chunks
```

What breaks without this boundary: if the model "ran" tools itself there'd be
no place to enforce policy, no audit point, no safety gate. The harness IS the
control story.

**Termination — two exits, both required.** The success exit fires when the
model emits no tool-use. The budget exit is the load-bearing one:

```
  forced synthesis — the budget exit

  if (last turn)  OR  (tool calls used up):
      forceFinal = true
      → call model with tools = undefined   (it CANNOT call a tool)
      → prepend "You have NO more tool calls available.
                 Do not say you need more queries."
      → whatever prose comes back IS the answer
```

What breaks without it: the model can answer "let me search again" forever and
the loop never ends. The cap alone isn't enough — you also have to *take the
tools away* on the final turn, or the model emits one last tool call you can't
service. Stripping the schemas is the part people forget.

**Skeleton vs hardening.** The four parts above are the skeleton. Hardening
layered on top in this same file: tool-result truncation to 16k chars
(stops one fat result from blowing the context), an `AbortSignal` checked each
turn (cancellation), `model_usage` trace events (observability), and a
structured-output recovery turn (unused by buffr — it passes no `parseResult`).

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs
**both** a success condition and a hard budget. Naming the budget — and naming
that you *remove the tools* on the final turn so the budget actually bites — is
the signal you've shipped an agent loop, not just read about one.

---

## Primary diagram

The full loop buffr runs, every box and the layer it sits in.

```
  buffr's bounded ReAct loop — full recap (maxTurns=6, maxToolCalls=4)

  ┌─ aptkit: runAgentLoop ──────────────────────────────────────────┐
  │                                                                  │
  │  messages = [ user: question ]                                   │
  │     │                                                            │
  │     ▼   for turn in 0..5:                                        │
  │  ┌─────────────────────────────────────────────┐                │
  │  │ forceFinal = (turn==5) OR (toolCalls>=4)      │                │
  │  │ model.complete(system, messages,             │                │
  │  │   tools = forceFinal ? undefined : schemas)   │ ← Gemma       │
  │  └───────────────┬─────────────────────────────┘                │
  │     emit step ───┤                                               │
  │                  │ tool_use?                                     │
  │            ┌─────┴─────┐                                         │
  │            │ no        │ yes                                     │
  │            ▼           ▼                                         │
  │       return text  callTool(search_knowledge_base) ── pgvector  │
  │       (success)        │  emit tool_call_start/end              │
  │                        ▼                                         │
  │                  push tool_result → messages → loop              │
  │                                                                  │
  │  (forceFinal turn: tools stripped + synthesis instr → answer)    │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Every `npm run ask -- "..."` invocation. The user asks a free-form question;
the agent decides whether to search the knowledge base, possibly refines the
query across up to 4 searches, then synthesizes a grounded answer. The loop is
reached for exactly when the answer depends on what the model finds in the
corpus — which is every question buffr handles.

### Code, side by side

The budget and exits, from `RagQueryAgent.answer`
(`@aptkit/agent-rag-query/dist/src/rag-query-agent.js:38-50`):

```
const { finalText } = await runAgentLoop({
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  model: this.options.model,        ← Gemma, context-guarded (ask-cmd.ts:26)
  tools: this.options.tools,        ← registry with one tool
  system: this.system,              ← profile + RAG instructions
  userPrompt: question,
  toolSchemas,                      ← filtered to [search_knowledge_base]
  trace: this.options.trace,        ← SupabaseTraceSink
  maxTurns: 6,                      ← hard loop bound
  maxToolCalls: 4,                  ← hard tool budget
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources...'),
});                                  └─ the "no more tools" turn's instruction
return finalText.trim() || FALLBACK_ANSWER;
        │
        └─ if even forced synthesis is empty, return a fixed string —
           the run ALWAYS produces something (rag-query-agent.js:51)
```

The forced-synthesis mechanism itself
(`@aptkit/runtime/dist/src/run-agent-loop.js:25-35`):

```
for (let turn = 0; turn < maxTurns; turn += 1) {       ← hard upper bound
  signal?.throwIfAborted();                             ← cancellation check
  const budgetSpent = maxToolCalls !== undefined
    && toolCalls.length >= maxToolCalls;                ← tool budget check
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const response = await model.complete({
    system: forceFinal && synthesisInstruction
      ? `${system}\n\n${synthesisInstruction}` : system,  ← inject "no more"
    messages,
    tools: forceFinal ? undefined : toolSchemas,        ← STRIP the tools
    maxTokens, signal,
  });
       │
       └─ forceFinal does TWO things at once: removes the tool schemas so a
          tool call is impossible, AND tells the model it has none left.
          Either alone is insufficient — strip-only and the model still tries;
          tell-only and the model can still emit an unserviceable call.
```

The success exit (`run-agent-loop.js:53-57`):

```
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {     ← model answered in prose
  finalText = text;              ← that prose is the answer
  break;                         ← leave the loop early
}
```

---

## Elaborate

ReAct comes from Yao et al. (2022) — the insight that interleaving reasoning
traces with actions beats either alone. The production-hardening here (budget +
forced synthesis) is the part the paper doesn't dwell on but every shipped
agent needs. Note buffr inherits these numbers from aptkit's defaults
(`maxTurns: 6`, `maxToolCalls: 4`); they're tuned for a single read-only
retrieval tool, where 4 searches is plenty and a 5th is almost always the model
spinning. A multi-tool agent would need a higher ceiling and per-tool budgets —
covered in `06-orchestration-templates.md`.

Adjacent: the loop sits directly on top of emulated tool calling
(`05-emulated-tool-calling.md`) — the `tool_use` blocks the loop reads are
synthesized by the Gemma provider from a parsed JSON blob, not a native tool
API. Read that file to see why the loop's `toolUsesFromContent` ever finds
anything on a stock model.

---

## Interview defense

**Q: What stops your agent from looping forever?**
Two independent caps and a forced exit. `maxTurns=6` bounds the loop; `maxToolCalls=4` bounds the tool budget; and on the final turn the harness *removes the tool schemas* and tells the model it has none left, so it must answer. The cap alone isn't enough — you have to take the tools away, or the model emits one last tool call you can't service.

```
  cap ──► strip tools ──► force answer
  (the strip is the part people forget)
```
Anchor: "The budget exit removes the tools; the cap alone doesn't bite."

**Q: Is this ReAct or a chain?**
ReAct. The model chooses each turn whether to search again, refine the query, or answer — the path isn't written by me. A chain would call `retrieve` once on a fixed schedule. Here retrieval is a tool the model decides to use 0–4 times.

```
  chain:  Q → retrieve → generate   (fixed)
  buffr:  Q → [model decides: search? refine? answer?] × ≤6
```
Anchor: "The model writes the steps at runtime; that's what makes it an agent."

---

## Validate

1. **Reconstruct:** From memory, write the four skeleton parts and the two
   exits. Name what breaks if each is removed. (Check against
   `run-agent-loop.js:20-115`.)
2. **Explain:** Walk why `forceFinal` sets `tools: undefined` *and* prepends an
   instruction — why is either alone insufficient? (`run-agent-loop.js:30-32`.)
3. **Apply:** A question needs 6 searches to answer well. Trace what buffr
   returns. (Hint: budget caps at 4, forced synthesis fires, answer is grounded
   in the first 4 results — possibly the `FALLBACK_ANSWER` if synthesis is
   empty, `rag-query-agent.js:51`.)
4. **Defend:** Argue for `maxToolCalls=4` vs `8`. What does buffr's single
   read-only tool make cheap, and what would change the number?
   (`rag-query-agent.js:48`.)

---

## See also

- `02-single-tool-capability-scope.md` — what the loop is allowed to call
- `03-agentic-retrieval.md` — the one tool the loop reasons with
- `05-emulated-tool-calling.md` — where the `tool_use` blocks come from on Gemma
- `04-trajectory-as-memory.md` — what the `trace.emit` calls persist
- `audit.md` — Lens 5 (control loop & termination)
- ReAct mechanics (sibling generator): `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`
- `.aipe/study-system-design/03-trajectory-capture.md`

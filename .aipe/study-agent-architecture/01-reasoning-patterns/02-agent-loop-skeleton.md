# The agent loop skeleton — the kernel everything else instantiates

**Industry name(s):** the agent control loop · the ReAct kernel · "the
while-loop with a budget." **Type label:** Industry standard.

## Zoom out, then zoom in

Every named pattern in this section — ReAct, plan-and-execute,
reflexion — and every topology in SECTION C is the *same loop* with a
different step function. Isolate that loop once and the rest is
variations. In buffr it lives in exactly one place: aptkit's
`runAgentLoop`.

```
  Zoom out — where the kernel lives

  ┌─ Agent layer (aptkit) ──────────────────────────────────┐
  │  RagQueryAgent.answer (rag-query-agent.js:35)            │
  │     │ delegates to                                       │
  │     ▼                                                    │
  │  ★ runAgentLoop (run-agent-loop.js:20) ★                 │ ← we are here
  │     for turn in 0..maxTurns:                             │
  │       step → execute tool → accumulate → terminate       │
  └───────────────────────────┬──────────────────────────────┘
                              │  tool intent / final text
  ┌─ Tool + provider layer ───▼──────────────────────────────┐
  │  search_knowledge_base · GemmaModelProvider.complete      │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: forget the names for a second. The kernel is a `while` loop
with four load-bearing parts and **two** exits. Get those right and
you've shipped an agent. Miss the second exit and you've shipped a
token bonfire.

## Structure pass

**Layers.** The loop is one layer; the step function (the model call)
and the execute function (the tool call) are the two things it
orchestrates.

**Axis — "what makes this a loop and not N independent calls?"** The
answer is *state*. Trace it: without an accumulating message array,
each turn is amnesiac and you have N unrelated calls. The `messages`
array (`run-agent-loop.js:22`) is the thing that makes it a loop.

**Seam.** The most important seam is `forceFinal`
(`run-agent-loop.js:28`) — the boundary between "model may call tools"
and "model must answer now." The control axis flips there: before it,
the model is in charge of whether to continue; after it, the harness
forces termination. That seam is the budget exit, and it's the part
people forget.

## How it works

#### Move 1 — the mental model (the load-bearing skeleton)

You've written this loop before without calling it an agent: a retry
loop with a max-attempts cap. `while (attempts < max) { try once; if
done break; }`. An agent loop is that shape, where "try once" is a
model call that picks the next action, and "done" is the model
emitting a final answer instead of a tool call.

```
  Pattern — the agent loop kernel (the whole pattern)

  runLoop(state, tools):
    while not done:
      action = step(state)         # ← model picks next move
      if action.is_final:          #   EXIT 1: success
        return action.output
      result = execute(action, tools)
      state  = update(state, result)   # ← accumulate (makes it a loop)
      if budget_exceeded(state):   #   EXIT 2: hard stop
        return forced_synthesis(state)
```

#### Move 2 — the four load-bearing parts, named by what breaks

This is a load-bearing-skeleton walkthrough: each part is named by
what breaks if you remove it, not by definition.

**1. state (accumulate) — drop it and it's not a loop.** Without an
accumulating context, every turn is amnesiac: the model can't see what
it already retrieved, so it can't build toward an answer. In buffr the
state is the `messages` array, seeded with the question and grown each
turn (`run-agent-loop.js:22,48,104`):

```js
const messages = [{ role: 'user', content: userPrompt }]; // seed
// ...each turn:
messages.push({ role: 'assistant', content: response.content }); // model's move
messages.push({ role: 'user', content: toolResults });           // tool's reply
```

Strip those `push`es and the model re-answers the raw question every
turn, never seeing the retrieved chunks. State is what turns N calls
into one reasoning chain.

**2. step (the single model call) — the only smart part.** Everything
else is plumbing; this is where the decision happens. In buffr it's
`model.complete(...)` (`run-agent-loop.js:29`). The model returns
either `tool_use` blocks (it wants to search) or text (it's done).
That's the one place "intelligence" enters the loop.

**3. execute (run the tool, feed the result back) — the safety
boundary.** The model emits *intent* — a JSON tool call — and the
harness runs it (`run-agent-loop.js:76`):

```js
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
```

The model never touches `PgVectorStore` directly. It says "search for
X"; `callTool` decides whether that's allowed and runs it. **That
boundary IS the control and safety story** — the model's output is
data the harness interprets, not code it executes. Remove it (let the
model's output trigger side effects directly) and you've built a
prompt-injection liability.

**4. termination — two exits, both required.** This is the part people
forget, so it gets its own diagram.

```
  Pattern — the two exits (both mandatory)

  ┌──────────────────────────────────────────────┐
  │  for turn in 0..maxTurns:                     │
  │    response = model.complete(...)             │
  │                                               │
  │    no tool_use in response?  ───► EXIT 1      │
  │                                   (success:   │
  │                                    model done)│
  │                                               │
  │    turn == last  OR  toolCalls >= budget?     │
  │                              ───► forceFinal  │
  │                                   strip tools │
  │                                   EXIT 2      │
  │                                   (budget)    │
  └──────────────────────────────────────────────┘
```

The **success exit** is obvious — the model emits no tool call, so the
loop breaks (`run-agent-loop.js:54-57`). The **budget exit** is the
one that matters, because *nothing guarantees the model ever reaches
the success exit*. A weak model can loop tool calls forever. buffr's
budget exit is two-pronged (`run-agent-loop.js:25-34`):

```js
for (let turn = 0; turn < maxTurns; turn += 1) {              // turn cap
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;    // either trips it
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,              // ★ tools stripped
    maxTokens, signal,
  });
```

`RagQueryAgent` sets `maxTurns: 6, maxToolCalls: 4`
(`rag-query-agent.js:47-48`). When either trips, `forceFinal` goes
true and two things happen at once: the tools array is set to
`undefined` (the model *physically cannot* call a tool), and a
synthesis instruction is appended — "You have NO more tool calls
available… Do not say you need more queries"
(`buildSynthesisInstruction`, `run-agent-loop.js:17-19`). That **forced
synthesis turn is the most load-bearing mechanic in the whole repo**:
it guarantees a final answer instead of a "let me search again" that
never resolves. The cap is not bolt-on hardening — it's part of the
skeleton. An agent shipped without it burns tokens in a silent loop.

**Skeleton vs hardening.** The four parts above are the skeleton.
Everything else in `runAgentLoop` is hardening: `truncate` on tool
results (`run-agent-loop.js:3-7`), the trace emits, the recovery turn
(`runRecoveryTurn`, line 116), structured-output parsing. Saying which
is which is the lesson — buffr's loop has all four skeleton parts and
several hardening layers, and you can read them apart now.

#### Move 2.5 — current vs future state

Single-turn vs multi-turn is not two patterns — it's this same
skeleton with a different loop count. If a buffr question needs no
search, the model answers on turn 0 and the loop exits after one step
(EXIT 1). If it needs two refining searches, the loop runs three
turns. Same kernel, different count. And the bridge to SECTION C:
multi-agent is *N of this skeleton composed* — but only "N independent
loops merged" when the agents are genuinely independent. The moment
one agent needs another's output, you're traversing a dependency DAG
with an orchestrator, not running N copies. buffr is N=1; the future
two-brain design in `agent-layer-plan.md` would be N>1.

#### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination
needs **both** a success condition and a hard budget. Naming the budget
unprompted — "the forced synthesis turn that strips tools at
maxToolCalls" — is the signal that you've actually shipped an agent
loop, not just read about one.

## Primary diagram

```
  runAgentLoop — the full kernel (run-agent-loop.js:20-114)

  messages = [{ user: question }]            ← STATE (seed)
        │
        ▼
  ┌─ for turn in 0..6 ───────────────────────────────────────┐
  │  forceFinal = (turn == last) || (toolCalls >= 4)          │
  │        │                                                  │
  │        ▼                                                  │
  │  response = model.complete(                               │  ← STEP
  │     tools: forceFinal ? undefined : toolSchemas,          │
  │     system: + synthesisInstruction if forceFinal)         │
  │        │                                                  │
  │  no tool_use? ──────────────────────────► EXIT 1 (success)│
  │        │ tool_use                                         │
  │        ▼                                                  │
  │  tools.callTool(name, args) ──────────────► EXECUTE       │
  │        │ result                                           │
  │        ▼                                                  │
  │  messages.push(assistant); messages.push(toolResults)     │  ← ACCUMULATE
  └────────────────────────────┬─────────────────────────────┘
                              loop, or hit turn cap → EXIT 2 (budget)
```

## Elaborate

This loop is the ReAct kernel (Reason–Act–Observe), but the *shape* —
accumulate-step-execute-terminate-with-budget — is older and broader:
it's the same shape as BFS (frontier + visited + termination), a rate
limiter (counter + window + reset), or a retry policy (attempt counter
+ max). What-breaks-if-removed is how you tell the load-bearing parts
from the incidental ones across all of them. The interview payoff is
identical: name the termination condition people forget.

## Interview defense

**Q: What's the minimum that makes something an agent loop?**
Four parts: a step function (the model picks the next action),
execute (the harness runs the tool and feeds the result back), state
(an accumulating context that makes it a loop and not N calls), and
termination — and termination is *two* exits, success and budget.

```
  step → execute → accumulate → terminate(success | budget)
```

**Anchor:** "The budget exit is the one people forget — buffr's is the
forced-synthesis turn that strips tools at maxToolCalls:4."

**Q: Why does buffr force a synthesis turn?**
Because nothing guarantees the model reaches the success exit on its
own — a weak local model can loop tool calls indefinitely. On the last
turn (`forceFinal`), the loop sets `tools: undefined` so the model
*can't* call a tool, and appends "you have NO more tool calls" so it
answers from what it already retrieved instead of asking for more
(`run-agent-loop.js:28-34`).

## See also

- `01-chains-vs-agents.md` — is there a loop at all
- `03-react.md` — the named pattern this kernel runs in buffr
- `04-agent-infrastructure/05-guardrails-and-control.md` — the budget
  exit as part of the full control envelope
- `05-production-serving/03-per-tool-circuit-breaking.md` — what the
  budget exit can't catch (a dead tool burning the budget)
- ReAct Thought–Action–Observation *mechanics* would live in
  `study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`

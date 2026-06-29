# Chains vs Agents — the boundary

*Industry names: **chain / workflow** vs **agent**. Type label: Language-agnostic (the boundary is conceptual; buffr's specific mix is Project-specific).*

## Zoom out, then zoom in

Here is where the boundary actually falls in buffr — it does not fall between files, it
falls between two **layers** inside the request path.

```
  Chains-vs-agents — the seam runs THROUGH buffr, not around it

  ┌─ Session layer — src/session.ts:60-71 ─────────────────────┐
  │   CHAIN-LIKE: engineer wrote the 3 steps, fixed order      │
  │   1. persistMessage(user turn)                             │
  │   2. agent.answer(q)  ──────────────┐                      │
  │   3. memory.remember(exchange)      │                      │
  └─────────────────────────────────────┼──────────────────────┘
                                        │  ★ THE SEAM ★
  ┌─ Agent layer — runAgentLoop ────────▼──────────────────────┐
  │   AGENT: the MODEL chooses the next step each turn         │
  │   loop { model decides: search_knowledge_base OR answer }  │
  │        run-agent-loop.ts:98-190                            │
  └────────────────────────────────────────────────────────────┘
```

buffr looks like a chain from the outside and is an agent on the inside. The session runs a
fixed three-step pipeline you could draw before the program runs. But step 2 hands control
to a model that decides, turn by turn, whether to search again or to answer. That is the
whole distinction: **a chain's control flow is written by the engineer; an agent's is
decided by the model at runtime.** buffr is both, stacked.

## Structure pass

Two layers, one axis: **control** — who picks the next step?

```
  Axis = CONTROL · trace it across the two layers, find where it flips

  Session layer        the ENGINEER picks the next step   (static)
        │                  persist, then answer, then remember
        │   ───────────────── ★ SEAM: control flips ★ ─────────────
        ▼
  Agent layer          the MODEL picks the next step      (dynamic)
                           search again? or answer now?
```

In a `.then().then().then()` chain you wrote in Vue, *you* decided the order — the data
flows through fixed stations. That is the session layer. The flip happens the moment
`agent.answer(q)` is called: from there down, no human or engineer decides whether a search
happens. The model emits either a tool-call intent or final prose, and that choice — not
your code — drives the next iteration. The seam is the single line `session.ts:62`.

## How it works

### Move 1 — mental model

A **chain** is a railway: stations in a fixed order, the train cannot choose a different
track. An **agent** is a driver with a map: same destination, but it picks turns based on
what it sees. buffr bolts a one-driver car onto the end of a three-station railway.

```
  The literal two shapes

  CHAIN (session.ts:60-71)            AGENT (run-agent-loop.ts:98-190)
  ┌──────┐  ┌──────┐  ┌──────┐        ┌──────── loop ────────┐
  │persist├─▶│answer├─▶│remmbr│        │  ┌────────┐          │
  └──────┘  └──┬───┘  └──────┘        │  │ model  │ decides  │
               │ this box IS          │  │ step   ├──┐       │
               │ the agent ───────────┼─▶│        │  │       │
                                      │  └────────┘  ▼       │
                                      │   search?  answer?   │
                                      │   ▲    │    │ exit    │
                                      │   └────┘    ▼        │
                                      └──────────────────────┘
```

### The session is the chain — a fixed sequence you can read top to bottom

The `ask()` method is a pipeline. You can draw it before any input arrives, because the
engineer wrote every edge. Bridge from frontend: this is the `.then()` chain you've written
a hundred times — persist, then await the answer, then write memory. The order is in the
source, not in the data.

```ts
// src/session.ts:60-71 — the chain. Read it like a Promise chain.
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);  // step 1 — fixed
  const answer = await agent.answer(question);                    // step 2 — the AGENT lives here
  await trace.flush();
  try {
    await memory.remember({ conversationId, question, answer });  // step 3 — fixed, best-effort
  } catch { /* memory is best-effort */ }
  return answer;
}
```

Annotation: steps 1 and 3 never reorder, never get skipped by a model decision. The only
non-deterministic box is `agent.answer` on the middle line. Everything around it is
hand-wired control flow — the definition of chain-like.

### The agent is the loop — a step the model controls

Drop one layer down into `answer()` and control inverts. The engineer no longer writes
"search, then answer." The engineer writes a *loop*, and the **model** decides each pass
whether to emit a tool call or final text.

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:66-80 — hands control to the loop
const { finalText } = await runAgentLoop({
  model: this.options.model,
  tools: this.options.tools,
  toolSchemas,            // the model MAY call search_knowledge_base — or not
  maxTurns: 6,            // bound on how many times the model gets to decide
  maxToolCalls: 4,        // bound on how many searches it may spend
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.',
  ),
});
```

```
  Inside answer() — control is the model's, per turn

  turn 0 ─▶ model: {"tool":"search_knowledge_base", ...}   ← MODEL chose to search
  turn 1 ─▶ model: {"tool":"search_knowledge_base", ...}   ← MODEL chose to search again
  turn 2 ─▶ model: "Based on the retrieved sources, ..."   ← MODEL chose to answer → EXIT
```

Annotation: the engineer never wrote "search twice then answer." The model produced that
trajectory. A different question yields zero searches or four. That runtime-decided shape
is what makes this an agent and not a chain. The mechanics of how the model emits that
choice (Thought-Action-Observation) live in `study-ai-engineering`'s `agents-vs-chains` —
this file is only about *where the boundary falls*.

### Move 3 — the principle

**Chain vs agent is not a property of a program; it is a property of a layer.** Ask of any
layer: *did the engineer write the order, or does the model decide it at runtime?* Static
order → chain. Runtime decision → agent. Real systems stack both, and the interesting
engineering is choosing where to put the seam. buffr puts deterministic, side-effecting
work (persist, remember) in the chain and the open-ended reasoning in the agent — side
effects stay predictable, reasoning stays flexible.

## Primary diagram

The full recap: one request, two control regimes, one seam.

```
  buffr — pipeline outside, loop inside (the hybrid verdict)

  ENGINEER-CONTROLLED (chain)                MODEL-CONTROLLED (agent)
  ┌───────────────────────────┐             ┌───────────────────────────────┐
  │ session.ask(q)            │             │ runAgentLoop                  │
  │  1 persist  ──────────────┼── seam ────▶│  for turn in 0..6:            │
  │  2 answer(q) ═════════════╪═════════════│    model decides:             │
  │  3 remember ◀─────────────┼─────────────│      search_knowledge_base?   │
  │                           │   finalText │      or final answer? (exit)  │
  └───────────────────────────┘             └───────────────────────────────┘
        static, hand-written                     dynamic, model-decided
        session.ts:60-71                         run-agent-loop.ts:98-190
```

The verdict in one line: **hybrid — chain-like pipeline on the outside, true ReAct agent
loop on the inside.** Don't call buffr "a chatbot" or "a chain"; call it a single-agent
loop wrapped in a deterministic persistence pipeline.

## Elaborate

The chain/agent split traces to the 2022-2023 split between "LLM chains" (LangChain's
original framing: prompt templates piped together) and "agents" (ReAct, 2022 — Yao et al.,
the model interleaves reasoning and tool use). The industry over-rotated to agents, then
corrected: Anthropic's 2024 "Building Effective Agents" guidance is explicitly *prefer
workflows; reach for agents only when you need model-decided control flow*. buffr follows
that guidance exactly — the deterministic parts (persist, remember, trace flush) are a
workflow; only the genuinely open-ended part (how many searches a question needs) is an
agent.

Read next: `02-agent-loop-skeleton.md` — once you accept that step 2 is an agent, the next
question is *what is the minimal kernel of that loop*, and what breaks if you remove each
part.

## Interview defense

**Q: "Is buffr a chain or an agent?"**

Model answer: "Both — and the precise answer is the point. The session layer
(`session.ts:60-71`) is chain-like: I wrote a fixed persist → answer → remember sequence,
no model decides the order. But `agent.answer` drops into `runAgentLoop`
(`run-agent-loop.ts:98-190`) where the model decides each turn whether to search again or
answer. So: pipeline outside, ReAct loop inside. I put side effects in the chain so they
stay deterministic, and the open-ended reasoning in the agent so it stays flexible."

```
  The defense in one picture

  [persist] → [ AGENT LOOP ] → [remember]
   engineer    model decides    engineer
   wrote it    each turn        wrote it
```

Anchor: *Control is the test — engineer-ordered is a chain, model-ordered is an agent; buffr
is one inside the other.*

## See also

- `02-agent-loop-skeleton.md` — the kernel of the inside-loop this file points at.
- `03-react.md` — what specific kind of agent loop buffr runs.
- `07-routing.md` — the model's per-turn search-or-answer choice, seen as a degenerate route.
- `study-ai-engineering` → `agents-vs-chains` — the Thought-Action-Observation *mechanics*
  this file deliberately defers.
- `../00-overview.md` — the three-shapes map this boundary sits on.

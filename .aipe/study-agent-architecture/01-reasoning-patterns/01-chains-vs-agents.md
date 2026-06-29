# Chains vs agents — the boundary

**Industry name(s):** workflow vs agent · "the autonomy boundary" ·
the chain/agent distinction. **Type label:** Industry standard.

## Zoom out, then zoom in

Before you can place any reasoning pattern, you have to answer one
question about a system: **does the engineer write the steps, or does
the model?** That single fork decides everything downstream — whether
you can predict the cost, how you debug it, where the failure modes
live. Here's where that fork sits in buffr-laptop.

```
  Zoom out — where the autonomy boundary lives

  ┌─ Session layer ─────────────────────────────────────────┐
  │  session.ask(q)  — fixed: persist → answer → remember    │
  │  (this part IS a chain — engineer wrote these 3 steps)   │
  └───────────────────────────┬──────────────────────────────┘
                              │  question
  ┌─ Agent layer ─────────────▼──────────────────────────────┐
  │  ★ THE BOUNDARY ★                                         │ ← we are here
  │  RagQueryAgent.answer → runAgentLoop                      │
  │  (this part IS an agent — MODEL decides search-or-answer) │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Tool layer ──────────────▼──────────────────────────────┐
  │  search_knowledge_base — a fixed function, no autonomy    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the interesting thing about buffr is that it's **both**, at
different altitudes. The session is a chain (three steps you can read
top to bottom in `src/session.ts:60-70`). The agent inside it is a
real loop (the model picks the next move). That nesting — fixed
outside, autonomous inside — is the shape to hold onto.

## Structure pass

**Layers.** Two: the session orchestration (outer) and the agent loop
(inner).

**Axis — "who decides control flow?"** Trace it down:

```
  One question, held constant down the layers

  "who decides what happens next?"

  ┌──────────────────────────────────────┐
  │ outer: session.ask (fixed 3 steps)   │  → CODE decides
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ inner: runAgentLoop (per turn)   │  → LLM decides
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ innermost: the tool handler  │  → TOOL just runs
          └──────────────────────────────┘

  the answer flips at each altitude — that flip IS the boundary
```

**Seam.** The load-bearing boundary is `agent.answer(question)` in
`src/session.ts:62`. Above it, control is the engineer's. Below it,
control is the model's. The axis flips exactly there. That's why it's
the seam worth studying: it's where predictability is traded for
flexibility.

## How it works

#### Move 1 — the mental model

You already know the difference, you just don't call it this. A
`.then()` chain — `fetchUser().then(loadOrders).then(render)` — has
its steps written by you; the runtime just executes them in order. A
chain is that. An agent is the opposite: you hand the model a goal and
a set of tools, and *it* decides the order at runtime, looping until
it's done.

```
  Pattern — chain vs agent control flow

  CHAIN (engineer writes the steps):
    input → step 1 → step 2 → step 3 → output
            └ LLM fills each slot, never picks what's next ┘

  AGENT (model writes the steps at runtime):
    ┌──────────┐
    │  Reason  │ ← model decides next action
    └────┬─────┘
         ▼
    ┌──────────┐
    │   Act    │ ← call a tool (or stop)
    └────┬─────┘
         ▼
    ┌──────────┐
    │ Observe  │ ← read the result
    └────┬─────┘
         └──── loop or stop
```

#### Move 2 — the walkthrough

**The chain half lives in the session.** Open `src/session.ts:60-70`.
Three steps, fixed order, every time:

```ts
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question); // step 1
  const answer = await agent.answer(question);                  // step 2
  await trace.flush();                                          // step 3a
  try { await memory.remember({ conversationId, question, answer }); } // 3b
  return answer;
}
```

You wrote those steps. Nothing chooses to skip persistence or run
`remember` before `answer`. That's a chain — and that's correct here,
because the orchestration order is genuinely fixed. The boundary
condition: if you ever needed the order to *depend on what the model
found*, this would have to become a loop too. It doesn't, so it stays
a chain.

**The agent half lives one call down.** `agent.answer(question)`
(`src/session.ts:62`) crosses into `RagQueryAgent.answer`
(`rag-query-agent.js:35`), which calls `runAgentLoop`
(`run-agent-loop.js:20`). Inside that loop, the model decides each
turn whether to emit a `search_knowledge_base` call or a final
answer:

```js
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {   // model chose to answer, not search
  finalText = text;
  break;                       // ← the model decided to stop
}
```

That `if` is the autonomy. The engineer did not write "search once
then answer." The model reads its own previous step and chooses. On
question 1 it might search twice; on question 2, not at all. Variable
step count is the price of autonomy.

```
  Layers-and-hops — control crossing the boundary

  ┌─ Session (code-controlled) ─┐  hop 1: answer(q)   ┌─ Agent (model-controlled) ─┐
  │  session.ask                │ ──────────────────► │  runAgentLoop              │
  │  fixed 3-step chain         │                     │  model picks search/answer │
  │                             │ ◄────────────────── │  per turn, capped at 6     │
  └─────────────────────────────┘  hop 2: finalText   └────────────────────────────┘
        control = ENGINEER          (the seam)              control = MODEL
```

#### Move 3 — the principle

Use a chain when you know the steps in advance; use an agent when the
steps depend on what the model finds. The cost of crossing into agent
territory is unpredictability — variable step count, variable cost,
harder debugging. buffr pays that cost only at the one altitude where
it buys something (the model deciding whether a question even needs
the knowledge base), and keeps everything around it a flat chain. That
discipline — autonomy only where it earns its keep — is the whole
lesson.

## Primary diagram

```
  buffr-laptop — chain wrapping an agent

  ┌─ CHAIN: session.ask (src/session.ts:60) ─────────────────┐
  │  persistMessage  →  ┌─ AGENT: runAgentLoop ─────────┐    │
  │  (user turn)        │  reason → act → observe → loop │    │
  │                     │  model decides; capped 6/4     │    │
  │                     └────────────┬──────────────────┘    │
  │                                  │ finalText             │
  │  trace.flush  ←──────────────────┘                       │
  │  memory.remember                                         │
  └──────────────────────────────────────────────────────────┘
   engineer-written order          model-written order
```

## Elaborate

The chain/agent distinction is the entry point to the whole
reasoning-pattern family. Every pattern in this section — the agent
loop skeleton, ReAct, plan-and-execute, reflexion — is a way of
structuring what happens *inside* the agent box above. They all assume
you've already decided to cross the boundary. The next file
(`02-agent-loop-skeleton.md`) isolates the kernel they all share.

The strong prior worth carrying: most systems should be chains, and
most "agents" in the wild would be cheaper, faster, and more
debuggable as chains with one well-placed model call. buffr earns its
agent because the search-or-answer decision genuinely depends on the
question.

## Interview defense

**Q: Is buffr a chain or an agent?**
It's a chain wrapping an agent. The session orchestration
(`src/session.ts:60`) is a fixed three-step chain; the
`RagQueryAgent` inside it (`rag-query-agent.js:35`) is a real ReAct
loop where the model decides whether to search. The boundary is the
`agent.answer()` call — control flips from engineer to model there.

```
  outer chain (fixed)  →  agent.answer()  →  inner loop (model decides)
         CODE                  SEAM                   MODEL
```

**Anchor:** "Fixed outside, autonomous inside — the autonomy boundary
is the `answer()` call."

**Q: How do you decide chain vs agent for a feature?**
Do you know the steps in advance? Chain. Do the steps depend on what
the model finds at runtime? Agent. The cost of the agent is variable
step count and cost — so only cross the boundary where that
flexibility buys a real capability. buffr crosses it once, for
search-or-answer, and stays a chain everywhere else.

## See also

- `02-agent-loop-skeleton.md` — the kernel inside the agent box
- `03-react.md` — the specific pattern buffr's loop runs
- `.aipe/study-system-design/04-long-lived-chat-session.md` — the
  session chain from the system-design angle
- ReAct / agents-vs-chains *mechanics* would live in
  `study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`
  (not yet generated in this repo)

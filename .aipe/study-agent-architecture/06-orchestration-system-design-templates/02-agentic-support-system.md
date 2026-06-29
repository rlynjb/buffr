# 02 — Agentic Support System

**Prompt:** *"Design an agent that resolves user requests by taking real ACTIONS across
tools, and escalates when it can't."*

The canonical answer is a **router → ReAct agent → guardrails → human escalation** pipeline.
The agent doesn't just answer — it *does things* (refund, reset, ticket), so the whole
design is about controlling actions and bailing to a human when confidence runs out.

```
  STANDARD ARCHITECTURE — action agent with guardrails + escalation
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  user request: "I was double-charged, fix it"                               │
  └───────────────────────────────────┬─────────────────────────────────────────┘
                                       ▼
                            ┌─────────────────────┐
                            │   INTENT ROUTER      │  classify → route to skill/agent
                            └─────────┬───────────-┘
                                      ▼
        ┌────────────────────────── ReAct LOOP ───────────────────────────┐
        │   ┌──────────┐   think    ┌──────────┐   act    ┌─────────────┐  │
        │   │  MODEL   │ ─────────► │  PLAN    │ ───────► │  TOOLS      │  │
        │   │          │ ◄───────── │  step    │ ◄─────── │ read +WRITE │  │
        │   └──────────┘  observe   └──────────┘  result  └─────────────┘  │
        │        ▲                                              │           │
        │        └──────────────── control envelope ───────────┘           │
        │              iteration cap · tool budget · forced finish          │
        └───────────────────────────────┬──────────────────────────────────┘
                                         ▼
        ┌──────────────────── GUARDRAILS (per action) ─────────────────────┐
        │  input sanitize  →  ACTION GATING  →  output schema check         │
        │  (clean args)       (allow? confirm?  (typed, validated result)   │
        │                      high-risk gate)                              │
        └───────────────────────────────┬──────────────────────────────────┘
                          can act │                  │ cannot / low-confidence
                                  ▼                  ▼
                         resolved + logged    ┌─────────────────┐
                                              │ HUMAN ESCALATION │  hand to agent,
                                              │  + escalation log │  log reason
                                              └─────────────────┘
```

The read-only version of this is easy. The hard, interview-worthy part is the right edge:
gating WRITE actions and knowing when to escalate. That edge is exactly what buffr doesn't
have, because buffr's only tool is a read.

## Standard architecture

- **Intent router:** classify the request, route to the right agent/skill. Keeps a refund
  request from hitting the password-reset tools.
- **ReAct agent:** think → act → observe loop with read AND write tools. Writes are what make
  it a "support system" instead of a FAQ bot.
- **Guardrails (three gates):**
  - *Input sanitize* — clean/validate tool args before they hit a real system.
  - *Action gating* — the load-bearing gate: is this action allowed for this user/role? Is it
    high-risk (refund > $X) and so requires confirmation or a human?
  - *Output schema* — the tool result must match a typed contract; reject malformed.
- **Human escalation:** when the agent can't resolve, or hits a gated high-risk action, hand
  to a human with the trajectory + a logged reason.

## Data model

- **Intent / route table:** intent → handler mapping.
- **Tool registry + capability policy:** which tools exist, and which an agent is *allowed* to
  call (least-privilege).
- **Action audit log:** every write attempt — args, gate decision, result, who/what approved.
  This is non-negotiable for an acting agent.
- **Escalation log:** every hand-off — reason, trajectory snapshot, resolution.
- **Trajectory store:** full think/act/observe trace for replay and dispute.

## Key components

- **Router:** Decision — LLM classifier vs. cheap embedding/keyword router. Cheap router for
  high-volume support; LLM only for ambiguous tails.
- **Action gate:** Decision — static policy (role × action matrix) vs. risk-scored dynamic
  gate. Most systems do static allow-list + a risk threshold that triggers human confirm.
- **Human-in-the-loop gate:** Decision — block-and-wait (synchronous approval) vs.
  optimistic-with-rollback. Refunds block; low-risk writes go optimistic.
- **Control envelope:** iteration cap + tool budget + forced finish so a confused agent can't
  loop forever spending actions.
- **Escalation trigger:** confidence threshold, repeated tool failure, or a gated action.

## Scale concerns

- **Action blast radius:** a write tool that misfires at scale is an incident, not a bad
  answer. Gating cost is worth it.
- **Escalation volume:** if too much escalates, the human queue is the bottleneck; if too
  little, the agent is taking unsafe actions. The escalation rate is a tuning dial.
- **Tool latency / failure:** real systems (payment APIs) fail; the loop needs retries +
  idempotency keys so a retried refund doesn't double-pay.
- **Audit-log growth:** every action logged → high write volume; needs partition/retention.

## Eval framing

- **Resolution rate:** fraction resolved without human, weighted by *correct* resolution
  (wrong-but-confident is worse than escalated).
- **Action correctness:** did it call the right tool with the right args? Eval the action, not
  the chat.
- **Escalation precision/recall:** did it escalate the ones it should, and only those?
- **Safety eval:** adversarial inputs trying to trigger unauthorized actions — the action gate
  is the thing under test.
- **Trajectory eval:** replay traces, assert the gate fired where required.

## Common failure modes

- **Confident wrong action:** agent "resolves" by taking the wrong write — worse than not
  acting.
- **Gate bypass via prompt injection:** user text talks the agent past the action gate.
- **Over-escalation:** everything punts to humans, the agent adds no leverage.
- **Under-escalation:** agent acts at the edge of its competence and breaks things.
- **No audit trail:** an action happened and you can't reconstruct why — undebuggable, often
  non-compliant.

## Applies to this codebase: **PARTIALLY — and NO on the action half**

This is the split verdict. buffr has the *left half* of the diagram (loop + envelope +
scoping) and **none of the right half** (action gating + escalation) — because it has no
actions to gate.

What buffr HAS (the loop + control left half):

- **The ReAct loop:** `runAgentLoop` drives think/act/observe, called from
  `/Users/rein/Public/aptkit/packages/agents/rag-query/src/rag-query-agent.ts:62-83`.
- **The full control envelope:** iteration cap + tool budget + forced synthesis at
  `/Users/rein/Public/aptkit/packages/runtime/src/run-agent-loop.ts:101-109` (and configured
  `maxTurns:6 / maxToolCalls:4` at `rag-query-agent.ts:75-76`). This is the template's
  control envelope, already built.
- **Capability scoping (least-privilege):** `ragQueryToolPolicy` at `rag-query-agent.ts:15-18`
  grants exactly one tool via `filterToolsForPolicy`
  (`/Users/rein/Public/aptkit/packages/tools/src/tool-policy.ts:11-23`). The "smallest blast
  radius" instinct is present.
- **A full trajectory trace:** every `CapabilityEvent` persisted at
  `/Users/rein/Public/buffr/src/supabase-trace-sink.ts:49-94` — the substrate an escalation
  log would build on.

What buffr LACKS (the entire action half):

- **No write tools.** The only tool is `search_knowledge_base`, a READ (`ragQueryToolPolicy`,
  `rag-query-agent.ts:15-18`). buffr **answers, it does not act.**
- **No action gating.** Nothing to gate — there are no writes. The hardest, most
  interview-relevant component is structurally absent.
- **No human escalation / gate.** Correct *for buffr*: a read-only agent can't do harm, so no
  human-in-the-loop is needed. The absence is a feature, not a gap, at the current scope.
- **No intent router.** One question → one loop.

So buffr is a **read-only support answerer**, not an acting support agent. It has proven it
can run a bounded, scoped loop — it has not proven it can take or gate a real-world action.

## How to make it apply

The refactor is gated by adding actions first, then the controls those actions require:

1. **Add write/action tools.** New tool definitions in the registry wired at
   `/Users/rein/Public/buffr/src/session.ts:43-44` (today only the search tool is
   registered). Each write tool gets added to an *expanded* `ragQueryToolPolicy`
   (`rag-query-agent.ts:15-18`) — least-privilege still holds, the allow-list just grows.
2. **Add action gating.** A gate between the loop and the tool handler: input sanitize → role
   check → high-risk confirm. This is the new component that the read-only design never
   needed.
3. **Add a human-in-the-loop gate.** A graph-orchestration step (LangGraph-style) that can
   *pause* the loop at a gated action and wait for approval — buffr's current straight-line
   `runAgentLoop` can't pause mid-flight, which is why graph orchestration is the enabler.
4. **Add an escalation log.** Extend the trace sink at `supabase-trace-sink.ts:49-94` with an
   escalation event type and a reason — the `CapabilityEvent` plumbing already lands every
   step, so this is an additive case, not new infrastructure.

Honest framing: buffr is **half** this template by construction. The left half (loop,
envelope, scoping, trace) is solid and reusable. The right half doesn't exist because buffr
made a deliberate choice — one read-only tool, smallest blast radius, no human gate needed.
To reach this template you change buffr from a thing that *answers* into a thing that *acts*,
and the moment you do, the action gate and escalation log stop being optional.

# System design template — agentic support / task system

Reframes buffr as the answer to "design an agent that resolves requests
by taking actions and escalates when it can't." Generic bullets first;
the last two about buffr only.

- **The prompt:** "Design an agent that resolves user requests by taking
  real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools
  (ReAct) → guardrails (input sanitize, action gating, output schema) →
  human escalation on low confidence or gated actions.

  ```
  request → router → ReAct agent + tools
                       │ guardrails: sanitize · gate actions · schema
                       ▼
                  resolve  |  low confidence / gated → human escalation
  ```

- **Data model:** conversation/run history with tool calls and
  confidence per turn, an escalation log, a tool registry, an action
  audit trail.

- **Key components:** routing, the agent loop, guardrails, the
  escalation gate, audit logging. Decision: which actions require human
  approval (irreversible / high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load, cost per resolved
  request, the escalation queue as the human bottleneck.

- **Eval framing:** resolution rate without escalation, tool-call
  accuracy, an adversarial set (prompt injection, out-of-scope),
  action-safety (no unauthorized side effects).

- **Common failure modes:** prompt injection in user input, the agent
  taking an unsafe action directly, an infinite loop on an unsolvable
  request, hallucinated tool results.

- **Applies to this codebase:** **partially — buffr is the read-only,
  no-action subset.** buffr is exactly the "single agent with tools
  (ReAct) + guardrails" core: `RagQueryAgent` is the ReAct agent
  (`rag-query-agent.js`), the loop has the iteration caps and forced
  synthesis (`run-agent-loop.js:25-34`), and the audit trail is the
  full-signal trajectory in `agents.messages`
  (`src/supabase-trace-sink.ts`). What buffr *deliberately omits* is the
  acting half: no router (one handler), no actions (the one tool is
  read-only search), so no action-gating, no escalation gate, no input
  sanitization (single-user, local). buffr answers questions; it doesn't
  *resolve requests by taking actions*. That makes it the safe subset of
  this template — all the control envelope, none of the action surface.

- **How to make it apply:** the refactor is adding *acting* tools, and
  every guardrail follows from that. (1) Add a write/act tool (e.g. the
  two-brain phone "do something" capability from `agent-layer-plan.md`)
  to the `InMemoryToolRegistry` in `src/session.ts:44` and grant it in a
  policy alongside `search_knowledge_base`. (2) The moment an acting tool
  exists, add the controls the read-only version skips: output schema
  validation, action-gating on irreversible actions, and a
  human-in-the-loop pause — which means converting `runAgentLoop`'s
  imperative loop toward graph orchestration so the run can pause and
  resume (`03-multi-agent-orchestration/07-graph-orchestration.md`). (3)
  Add input sanitization once there's an untrusted input path. Gating
  item: buffr's read-only stance is its strongest guardrail (no path from
  model output to a side effect — see
  `04-agent-infrastructure/05-guardrails-and-control.md`). Crossing into
  acting trades that structural safety for capability, so only do it for
  actions that genuinely need to be taken, and add the gate *with* the
  tool, not after.

## See also

- `01-reasoning-patterns/03-react.md` — the agent core buffr already is
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control
  envelope this template needs in full
- `.aipe/study-security/04-least-privilege-tool-scope.md` — the
  read-only scope this template would expand

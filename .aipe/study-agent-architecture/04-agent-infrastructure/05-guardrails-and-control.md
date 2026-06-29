# Guardrails and Control

*Industry names: **guardrails** / **the control envelope** / **capability scoping** (the
least-privilege half). Type label: Industry standard (the envelope is universal; buffr's
specific bounds and one-read-tool scope are Project-specific). IMPLEMENTED in buffr.*

## Zoom out, then zoom in

An autonomous loop that can call tools is, by default, an unbounded process with a side-effect
surface. Guardrails are the envelope you wrap around it so it always stops, and so the worst it can
do is small. This file collects buffr's control mechanisms — the bounds from Section A, now read as
a *safety* property, plus the one that makes buffr's blast radius the smallest possible: it has
exactly one tool, and that tool is a read.

```
  buffr's stack — guardrails wrap the loop on every side

  ┌─ RagQueryAgent — sets the envelope ────────────────────────────┐
  │  maxTurns:6 · maxToolCalls:4 · ragQueryToolPolicy (1 read tool)│
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ ★ GUARDRAILS + CONTROL — what STOPS it ★ ────────▼────────────┐
  │  iteration cap · tool budget · forced synthesis on exhaustion  │
  │  capability scoping → ONE read-only tool → no side-effect path │
  └──────────────────────────┬─────────────────────────────────────┘
  ┌─ The loop — runs INSIDE the envelope ─────────────▼────────────┐
  │  step → execute → accumulate → terminate                       │
  └─────────────────────────────────────────────────────────────────┘
```

The surprising part: buffr needs **no human-in-the-loop gate** — and that's not a gap, it's a
consequence of the design. The agent's only tool is read-only, so its output cannot trigger a side
effect. The load-bearing idea: **the strongest guardrail isn't a check on the output, it's
shrinking what the agent can touch in the first place.**

## Structure pass

Two kinds of control, one axis: **runaway vs damage** — what each guardrail prevents.

```
  Axis = WHAT IT PREVENTS · trace the two failure classes the envelope covers

  TERMINATION guardrails — prevent RUNAWAY (the loop never stops)
    iteration cap     maxTurns:6        → at most 6 model calls
    tool budget       maxToolCalls:4    → at most 4 searches
    forced synthesis  strip tools @ exhaustion → MUST answer    run-agent-loop.ts:101-109
  ───────────────── ★ SEAM: from "stops" to "can't harm" ★ ─────────────────
  SCOPING guardrail — prevents DAMAGE (the agent does something it shouldn't)
    capability scoping  ONE read-only tool → no side-effect path  rag-query-agent.ts:15-18
```

The seam separates two questions a guardrail can answer. Above it: *does the loop stop?* (the
termination bounds). Below it: *if the model is wrong or hijacked, how much damage can it do?* (the
scope). buffr answers both — bounds for runaway, scope for damage — and the scope answer is the
strong one, because a read-only tool has no damage to bound.

## How it works

### Move 1 — mental model

A guardrail is a constraint placed *outside* the model, enforced by the harness, that the model
cannot talk its way around. Bridge from frontend: it's the difference between client-side validation
(the model "deciding" to stop) and server-side validation (the harness *making* it stop). You never
trust the client; you never trust the model to bound itself. Two layers: bounds that force a stop,
and a scope that limits reach.

```
  THE SHAPE — the envelope: bounds force a stop, scope limits reach

  ┌─ TERMINATION (forces a STOP) ──────────────────────────────────┐
  │  maxTurns:6 · maxToolCalls:4 · forced synthesis on exhaustion  │
  │  harness-enforced — the model cannot override it               │
  └────────────────────────────────────────────────────────────────┘
  ┌─ SCOPING (limits REACH) ───────────────────────────────────────┐
  │  ragQueryToolPolicy: allowedTools = [search_knowledge_base]    │
  │  one read-only tool → no write, no side effect → blast radius ≈ 0│
  └────────────────────────────────────────────────────────────────┘
```

### Termination: the bounds force a stop (covered as termination in Section A)

The iteration cap and tool budget are set on the agent and enforced by the loop. They're the same
bounds the agent-loop-skeleton file teaches as *termination* — here, read them as *control*: they
guarantee the process ends regardless of what the model wants. Bridge from known: it's a `for` loop
with a hard `maxTurns`, plus a counter that strips capabilities when spent.

```ts
// @aptkit/agents/rag-query — rag-query-agent.ts:75-79 — the bounds set on the agent.
const { finalText } = await runAgentLoop({
  ...
  maxTurns: 6,                          // iteration cap: at most 6 model calls
  maxToolCalls: 4,                      // tool budget: at most 4 searches
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.',
  ),                                    // what to say when the budget is spent
});
```

```ts
// @aptkit/runtime — run-agent-loop.ts:101-109 — FORCED SYNTHESIS when the budget is exhausted.
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // 4 spent?
const forceFinal = turn === maxTurns - 1 || budgetSpent;                             // last turn OR budget gone
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  tools: forceFinal ? undefined : toolSchemas,   // ← tools STRIPPED: the model CANNOT search now
  ...
});
```

```
  TERMINATION — bounds force a stop the model can't override

  every turn:  budgetSpent = toolCalls >= 4   forceFinal = lastTurn OR budgetSpent
                                                  │
                          forceFinal? ── yes ──▶ strip tools + "NO more tool calls"
                                                  │  model has no option but to answer
                                                  ▼
                                            the loop STOPS with a real answer
```

Annotation: forced synthesis (`:101-109`) is stronger than counting alone. It doesn't just check a
counter — it *removes the tools from the request* on the exhausting turn, so even a model determined
to search again physically cannot. The bound isn't a request to the model; it's a fact about what the
model is offered. (Full treatment in `../01-reasoning-patterns/02-agent-loop-skeleton.md`.)

### Scoping: one read-only tool is the whole blast radius

This is the guardrail that makes buffr safe, not just bounded. `ragQueryToolPolicy` is a
least-privilege allowlist naming exactly one tool. `filterToolsForPolicy` enforces it: the model is
only ever *shown* the tools on the list, so it can only ever *ask* for them. And that one tool is a
read. Bridge from known: it's a database role with `SELECT` granted and nothing else — the role
can't `DELETE` because the grant was never made.

```ts
// rag-query-agent.ts:15-18 — least-privilege grant: exactly one allowed tool.
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← the WHOLE allowlist. One read tool.
};
```

```ts
// @aptkit/tools — tool-policy.ts:11-23 — the policy is ENFORCED, not advisory.
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))         // drop anything not on the allowlist
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}
// rag-query-agent.ts:63-64 — applied before the loop: the model only SEES the scoped tools.
const allTools = await this.options.tools.listTools();
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);
```

```
  SCOPING — the model can only ask for what it was shown

  registry has tools ─▶ filterToolsForPolicy(allowlist=[search_knowledge_base])
                              │ drops everything not on the list
                              ▼
                     model is SHOWN one read-only tool
                              │ so it can only ASK for a read
                              ▼
   no write tool exists in scope → output CANNOT trigger a side effect → blast radius ≈ 0
```

Annotation: the scoping happens *before* the loop runs (`rag-query-agent.ts:63-64`), so the model
never even learns other tools exist. This is the security-relevant move: a model that's hallucinating,
or hijacked by a prompt injection inside a retrieved document, can still only *ask* to search. There's
no `delete_user`, no `send_email`, no `run_sql` in scope to ask for. The damage a successful injection
could do is bounded to "search the knowledge base," which is exactly what the agent does anyway.

### Why there's no human-in-the-loop gate (and that's correct)

A human-in-the-loop gate exists to catch a *side effect* before it commits — pause before sending the
email, before the irreversible write. buffr has no side effect to gate. Its one tool reads; its output
is text returned to the user. There is nothing to approve, so adding a gate would be ceremony, not
safety. Bridge from known: you don't put a confirmation modal on a `SELECT` query.

```
  THE LOGIC — no gate needed because there's no side effect to gate

  human gate guards ──▶ irreversible side effects (write / send / pay / delete)
  buffr's only tool ──▶ search_knowledge_base  = a READ
  ∴ no side effect   ──▶ nothing to approve     ──▶ no gate (correct, not missing)
```

Annotation: name this as a *consequence* of capability scoping, not a missing feature. The moment
buffr grows a write tool (a "save note," a "schedule reminder"), the gate stops being ceremony and
becomes required. The absence of the gate is downstream of the read-only scope.

### Move 3 — the principle

**Bound the loop so it stops; scope the capabilities so that when it's wrong, it can't do harm — and
the scope is the stronger guardrail.** Termination bounds answer "does it stop?"; capability scoping
answers "how bad is it when the model is wrong?" The second question is the one that matters under
adversarial input, because you cannot make a model never wrong — you can only make its wrongness
cheap. buffr makes it cheap by giving the agent the smallest possible surface: one read. The
staff-engineer reflex when reviewing any agent: don't ask "is the model accurate," ask "what's the
worst this tool list can do," and shrink the list until the answer is "almost nothing."

## Primary diagram

Full recap: the two-layer envelope, the bounds, the scope, and why no gate.

```
  buffr's control envelope (rag-query-agent.ts:15-18,63-64,75-79 · run-agent-loop.ts:101-109)

  TERMINATION (prevents runaway — the loop always stops)
  ┌────────────────────────────────────────────────────────────────┐
  │ maxTurns:6 · maxToolCalls:4                       (:75-76)      │
  │ forced synthesis: strip tools @ exhaustion        (:101-109)    │
  │   → harness-enforced, the model can't override                 │
  └──────────────────────────┬─────────────────────────────────────┘
  SCOPING (prevents damage — the blast radius is tiny)
  ┌──────────────────────────▼─────────────────────────────────────┐
  │ ragQueryToolPolicy: allowedTools=[search_knowledge_base] (:15-18)│
  │ filterToolsForPolicy enforces it before the loop  (:11-23,:63-64)│
  │   → ONE read-only tool → no side-effect path → blast radius ≈ 0 │
  └──────────────────────────┬─────────────────────────────────────┘
  NO HUMAN GATE
  ┌──────────────────────────▼─────────────────────────────────────┐
  │ nothing to approve: the only tool is a READ → gate = ceremony   │
  └────────────────────────────────────────────────────────────────┘
```

Bounds force the stop; one read-only tool caps the damage; no gate because there's no side effect.
That's the whole control envelope.

## Elaborate

The two halves of the envelope defend different threats and shouldn't be conflated. The termination
bounds defend against an *operational* failure — a stubborn model burning turns and tokens forever (a
local 9B will happily say "one more search" indefinitely). Capability scoping defends against a
*security* failure — a model that's wrong or hijacked doing something irreversible. A system can have
perfect termination and still be dangerous (bounded but with a `delete_everything` tool in scope), or
perfectly scoped and still hang (one read tool, but no turn cap). buffr has both, and they're set
independently: the bounds live on the `runAgentLoop` call, the scope lives in `ragQueryToolPolicy`.

The multi-agent shape of control is a *supervisor*: in a fleet, the envelope moves up a level — a
supervising agent or policy layer decides which sub-agent may run, with which tools, and kills runs
that misbehave. buffr is single-agent, so its envelope is flat: one set of bounds, one scope, no
supervisor needed. The supervisor is what you add when a *second* agent with *write* tools enters the
system — that's when scoping-per-agent and run-killing become real work (Section C).

Cross-ref `study-security` for the prompt-injection blast-radius analysis — the threat model under
which capability scoping is the primary defense. A retrieved document can contain injected
instructions; this file's point is that even a *successful* injection is contained, because the only
tool it can reach is a read. That file covers the per-call injection defense; this one covers the
architectural containment.

## Interview defense

**Q: "What stops your agent from running forever, or doing something destructive?"**

Model answer: "Two independent layers. Termination: `maxTurns:6` and `maxToolCalls:4`
(`rag-query-agent.ts:75-76`), and on exhaustion the loop *strips the tools* and forces synthesis
(`run-agent-loop.ts:101-109`) — so a stubborn model that wants 'one more search' physically can't,
because the tools aren't offered. That guarantees it stops. Damage: capability scoping. The agent's
allowlist is exactly one tool — `ragQueryToolPolicy.allowedTools = [search_knowledge_base]`
(`:15-18`), enforced by `filterToolsForPolicy` before the loop runs (`tool-policy.ts:11-23`), so the
model is only ever shown one tool, and it's a read. There's no write, no side effect, so even a
prompt injection inside a retrieved document can at worst make it search. That's why there's no
human-in-the-loop gate — there's no side effect to approve. The strongest guardrail isn't checking
the output, it's shrinking what the agent can touch."

```
  The defense in one picture

  runaway?  → maxTurns:6 + maxToolCalls:4 + strip-tools-on-exhaustion  → always STOPS
  damage?   → ONE read-only tool in scope  → no side-effect path        → blast radius ≈ 0
  gate?     → none needed: nothing to approve when the only tool is a READ
```

Anchor: *Two layers — termination bounds (maxTurns:6, maxToolCalls:4, forced synthesis at
`run-agent-loop.ts:101-109`) force the stop; capability scoping to one read-only tool
(`ragQueryToolPolicy:15-18`, `filterToolsForPolicy:11-23`) caps the blast radius; no human gate
because a read has no side effect to approve.*

## See also

- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the same bounds, taught there as
  *termination* (the budget exit); here they're read as *control*.
- `03-tool-calling-and-mcp.md` — `filterToolsForPolicy` filters which registry tools the model is
  shown; scoping is applied at that seam.
- `04-agent-evaluation.md` — the bounds are what *trajectory efficiency* would be measured against.
- `../03-multi-agent-orchestration/` — the supervisor, the multi-agent shape of this envelope.
- `study-security` → prompt-injection blast-radius analysis; this file is the architectural
  containment half of that story.

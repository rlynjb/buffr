# Per-Tool Circuit Breaking

*Industry names: **circuit breaker** (the state machine) / **error-as-observation** (the
substrate). Type label: Industry standard. In buffr: the error-observation substrate is
IMPLEMENTED (a tool throw is caught and fed back to the model as an observation); the
open/half-open state machine is NOT YET wired. buffr's `maxToolCalls:4` caps the blast today.*

## Zoom out, then zoom in

```
  buffr's serving stack — a breaker would scope to the ONE tool

  ┌─ THE LOOP ─ run-agent-loop.ts:76-202 ─ N turns, re-hits the tool ──┐
  │ ┌─ ★ PER-TOOL CIRCUIT BREAKER ★ ─ the state machine ────────────┐ │  NOT YET
  │ │  CLOSED → (failures) → OPEN → (cooldown) → HALF-OPEN → probe   │ │
  │ │ ┌─ ERROR-AS-OBSERVATION ─ run-agent-loop.ts:163-187 ─────────┐ │ │  IMPLEMENTED
  │ │ │  try/catch wraps the throw into a tool_result {isError}    │ │ │
  │ │ │  fed back next turn → the agent SEES the failure           │ │ │
  │ │ │ ┌─ THE TOOL ─ search_knowledge_base → local pgvector ────┐ │ │ │
  │ │ │ │  the one (possibly flaky) dependency                   │ │ │ │
  │ │ │ └─────────────────────────────────────────────────────────┘ │ │ │
  │ │ └─────────────────────────────────────────────────────────────┘ │ │
  │ └─────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────┘
```

A circuit breaker stops sending requests to a dependency that's already failing, so you fail
fast instead of hammering a dead service. In an *agent* the twist is the loop: the same tool is
re-hit every turn, so a dead dependency doesn't fail once — it fails N times until the budget
burns. buffr has the **substrate** (★'s inner box: it catches a tool error and shows it to the
model) but not the **state machine** (★'s outer box: open/half-open). The error-observation is
real; the breaker is not yet.

## Structure pass

Two layers, traced along ONE axis: **what reacts to the failure**.

```
  Axis = WHO REACTS · trace the failure from the dependency up to the loop

  ERROR-AS-OBSERVATION   reactor = the MODEL    failure becomes a tool_result {isError}
    try/catch → wrap throw → feed back next turn → agent can route around   :163-187  IMPLEMENTED
  ──────────────── ★ SEAM: the model reacts vs the harness reacts ★ ──────────────────────
  CIRCUIT BREAKER        reactor = the HARNESS  failure count → OPEN → short-circuit the call
    state machine: CLOSED/OPEN/HALF-OPEN, cooldown, probe                   NOT YET
```

The seam is *who decides to stop calling*. Below it, the **model** decides — it sees an
`isError` observation and *may* choose to stop using that tool or rephrase. Above it, the
**harness** decides — after K failures it opens the circuit and refuses to make the call at all,
regardless of what the model asks. buffr has the lower layer (the model can see and react) but
not the upper (the harness will still dutifully re-call a dead pgvector every turn until the
tool budget is spent).

## How it works

### Move 1 — mental model

A circuit breaker is a wrapper around a flaky dependency that counts failures and, past a
threshold, *stops calling it* — returning a fast failure instead — then periodically probes to
see if it recovered. The frontend reflex: wrapping a flaky third-party `fetch` so that after N
consecutive 500s you stop hitting it for 30 seconds, serve a fallback, then try one request to
see if it's back. Three states: **CLOSED** (calls pass), **OPEN** (calls short-circuit),
**HALF-OPEN** (one probe decides).

```
  THE SHAPE — the breaker around a flaky dependency (fetch you stopped hammering)

  CLOSED ──(K failures)──▶ OPEN ──(cooldown elapsed)──▶ HALF-OPEN ──probe──┐
     ▲  calls pass through      calls short-circuit         one trial call  │
     │                          (fail fast, no dependency)                  │
     └──────────────── probe succeeds ───────────────────────────────◀─────┘
                       probe fails → back to OPEN
```

### Move 2 — the substrate, then the missing machine

**Error-as-observation: the substrate buffr DOES have.**

When the one tool throws — pgvector is down, the query errors — the loop doesn't crash. It
catches the throw, wraps it into a `tool_result` marked `isError`, and feeds it back into the
`messages` array as the next observation. So the model *sees* the failure on the following turn
and can reason about it.

```
  ERROR-AS-OBSERVATION — a tool throw becomes an observation the model sees

  callTool(search_knowledge_base) ──throws──▶ catch
                                                │ wrap: {error: message}, isError: true
                                                ▼
                            messages.push(tool_result {isError})  ──next turn──▶ MODEL sees it
                                                                                  may route around
```

```ts
// @aptkit/runtime — run-agent-loop.ts:163-187 — the throw is caught and turned into an observation.
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  resultContent = truncate(JSON.stringify(result));
} catch (error) {                                          // :163 — pgvector down → throw lands HERE
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));   // :167 — the error becomes content
}
// ...:181-186 — the error is pushed back as a tool_result the model reads next turn:
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,
  ...(isError ? { isError: true } : {}),                   // ← flagged so the model knows it FAILED
});
// :189 — appended to messages → becomes the next turn's observation
messages.push({ role: 'user', content: toolResults });
```

Annotation: this is the **substrate a breaker builds on**. The loop already converts a tool
failure into something the agent observes (`:163-187`) rather than a crash. That's the
agent-specific half — in a non-agent system you'd just propagate the error; here the *model* is a
potential reactor, so the failure is handed to it as data. This is implemented and load-bearing.

**The circuit-breaker state machine: the part that's NOT YET wired.**

What buffr lacks is the harness-side machine: a per-tool failure counter that, past a threshold,
**opens** the circuit and short-circuits the call without touching pgvector — then probes after
a cooldown.

```
  PER-TOOL BREAKER (sketch, not in buffr) — the harness stops calling a dead tool

  before callTool(search_knowledge_base):
        breaker[tool].state == OPEN ?
            ├── yes ──▶ short-circuit: return {error:"circuit open"} WITHOUT calling pgvector
            └── no  ──▶ call it → on throw, failures++ → failures ≥ K → state = OPEN (start cooldown)
        cooldown elapsed → state = HALF-OPEN → next call is a single probe → success closes, fail re-opens
```

```text
// SKETCH — not in buffr. A breaker scoped to ONE tool, wrapping the callTool above.
if (breaker.isOpen("search_knowledge_base")) {
  resultContent = JSON.stringify({ error: "search temporarily unavailable (circuit open)" });
  isError = true;                                  // STILL fed back as an observation — substrate reused
} else {
  try { /* the existing callTool */ breaker.recordSuccess("search_knowledge_base"); }
  catch (e) { breaker.recordFailure("search_knowledge_base"); /* K failures → open */ throw e; }
}
```

Annotation: note the breaker would **reuse** the error-observation substrate — an open circuit
still feeds an `isError` observation back to the model, just without hitting the dead dependency.
The missing piece is purely the state machine (the counter, the OPEN/HALF-OPEN transitions, the
cooldown). **buffr's would-need: a flaky shared dependency the loop re-hits enough that
fail-fast beats re-call.** Today pgvector is local and the failure mode is "down or up," not
"flaky under load," so the machine hasn't earned its keep.

**Why the loop makes this matter: one dead tool burns the whole budget.**

In a single call, a dead dependency fails once. In a *loop*, the agent re-issues the tool every
turn — so without a breaker, one dead tool + a loop = the entire iteration budget spent retrying
a corpse.

```
  WHY THE LOOP RAISES THE STAKES — re-hit every turn until the budget burns

  no breaker:  turn1 search→FAIL  turn2 search→FAIL  turn3 search→FAIL  turn4 search→FAIL
               └──────────── all 4 tool calls wasted on a dead pgvector ───────────────┘
  buffr today: maxToolCalls:4 CAPS the bleed at 4 — the budget is the crude backstop
  with breaker: turn1 FAIL→open  turn2+ short-circuit fast → budget spent on SYNTHESIS, not retries
```

Annotation: buffr's `maxToolCalls:4` is the crude backstop that bounds the blast *today* — a
dead tool can waste at most four calls, not infinity. A breaker would do better: open after the
first failure so the remaining budget goes to *answering with what it has* rather than retrying
a dead dependency. The budget caps the damage; the breaker would avoid most of it.

### Move 3 — the principle

**Feed tool failures back to the agent as observations (so it can route around them), and put a
harness-side breaker around any flaky tool the loop will re-hit (so a dead dependency doesn't
burn the whole iteration budget).** The two layers are complementary, not redundant: the
observation lets the *model* adapt; the breaker lets the *harness* refuse to call a known-dead
tool regardless of what the model asks. buffr ships the first and bounds the second with a
budget. The staff-engineer read: in a single call a dead dependency is one failure, but in a
loop it's a *multiplied* failure, so the breaker's value scales with the iteration count — which
is exactly why it's an agent-serving concern and not just a call-level one.

## Primary diagram

Both layers, with buffr's status and the budget backstop.

```
  Per-tool circuit breaking in buffr — substrate yes, state machine no

  CIRCUIT BREAKER (harness reacts)   CLOSED→OPEN→HALF-OPEN, cooldown, probe      NOT YET
        │ would short-circuit a dead tool, reusing the observation below
        ▼
  ERROR-AS-OBSERVATION (model reacts) try/catch → tool_result {isError} :163-187  IMPLEMENTED
        │ the model SEES the failure next turn and may route around it
        ▼
  THE TOOL  search_knowledge_base → local pgvector  (the dependency)

  Backstop today: maxToolCalls:4 caps a dead tool's bleed at 4 calls (crude, but bounded).
```

The agent already observes tool failure; what's missing is the harness refusing to re-call a
known-dead tool. The budget caps the cost in the meantime.

## Elaborate

The two layers fail differently and you want both. Error-as-observation makes the agent
*adaptive* — a model that sees `isError` can rephrase its query, try a different angle, or
synthesize from what it has. But it's only as reliable as the model's judgment; a stubborn local
9B might re-issue the same failing query, which is exactly where the harness-side breaker earns
its keep by *removing the option*. Conversely, a breaker with no observation would short-circuit
silently and leave the model guessing why its tool "returned nothing." buffr has the
observation; the breaker's absence is currently masked by `maxToolCalls:4`, which is why it
hasn't hurt — the budget is a blunt instrument that happens to cap the same blast radius.

The fleet shape is where the breaker becomes mandatory. Many agents hammering one shared flaky
dependency is the classic cascading-failure setup: without per-tool breakers, every agent
re-hits the dying service every turn, and the retries themselves keep it down. A breaker per
(agent, tool) lets the fleet fail fast and shed load, which is also a *form* of backpressure
(file 02) — stop sending to a dead consumer. buffr is single-agent against a local dependency,
so the cascade can't form; the breaker is a design target named against the day a tool calls out
to a shared or remote service that can be flaky under load rather than simply up-or-down.

Cross-ref `study-ai-engineering/06-production-serving/` for the call-level circuit-breaker state
machine (the CLOSED/OPEN/HALF-OPEN mechanics, thresholds, cooldown tuning); this file is the
*agent* view — where that breaker is scoped per-tool and its output is fed back as an
observation the loop reasons over.

## Interview defense

**Q: "What happens when a tool fails mid-loop? Do you have a circuit breaker?"**

Model answer: "Two layers, and I'm precise about which I have. The substrate is implemented: when
my one tool throws — say local pgvector is down — the loop catches it and wraps it into a
`tool_result` flagged `isError` (`run-agent-loop.ts:163-187`), pushed back into the `messages`
array as the next observation. So the *model sees the failure* and can route around it — rephrase,
or synthesize from what it has — rather than the run crashing. What I don't have yet is the
harness-side state machine: a per-tool breaker that counts failures, opens after K, short-circuits
the call without touching the dead dependency, and probes after a cooldown (CLOSED/OPEN/HALF-OPEN).
Why it matters more in a loop than a single call: the agent re-hits the same tool every turn, so
one dead tool without a breaker burns the *whole* iteration budget on retries. Today `maxToolCalls:4`
is my crude backstop — a dead tool wastes at most four calls, not infinity. A breaker would do
better: open on the first failure so the remaining budget goes to answering, not retrying a corpse.
It's not wired because pgvector is local and either up or down, not flaky under load — the breaker
earns its keep against a shared or remote dependency, which I'd name as the trigger to add it."

```
  The defense in one picture

  tool throws?     caught → tool_result {isError} fed back :163-187  → MODEL sees it (substrate YES)
  breaker?         NO state machine (CLOSED/OPEN/HALF-OPEN) — NOT YET
  why it matters?  loop re-hits the tool every turn → one dead tool burns the whole budget
  backstop today?  maxToolCalls:4 caps the bleed at 4 calls (crude but bounded)
```

Anchor: *Error-as-observation is implemented — a tool throw is caught and fed back as a
`tool_result {isError}` the model sees next turn (`run-agent-loop.ts:163-187`), the substrate a
breaker builds on; the open/half-open state machine is NOT YET wired, so a dead tool is re-hit
every turn and only `maxToolCalls:4` caps the bleed (at 4 calls) — the breaker earns its keep
against a flaky shared/remote dependency, which buffr's local pgvector isn't yet.*

## See also

- `02-fan-out-backpressure.md` — an open breaker is a *form* of backpressure (stop sending to a
  dead consumer), scoped to one tool instead of the whole fan-out.
- `01-cross-turn-caching.md` — the other per-loop serving control; a cache hit means the call
  never reaches the dependency the breaker guards.
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool-calling path the breaker
  would wrap; `callTool` is the seam.
- `../04-agent-infrastructure/05-guardrails-and-control.md` — `maxToolCalls:4` lives there as a
  termination bound; here it's read as the crude backstop a breaker would refine.
- `study-ai-engineering/06-production-serving/` — the call-level circuit-breaker state machine
  (CLOSED/OPEN/HALF-OPEN mechanics) this file points back to.

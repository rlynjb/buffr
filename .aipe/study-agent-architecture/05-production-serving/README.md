# E — Production Serving (a loop, not one call)

*Sub-section index — Industry standard. Mostly DESIGN TARGETS for buffr; two controls IMPLEMENTED.*

Sections A–D served a single thought: how the one model reasons, retrieves, remembers, and
gets bounded. This section asks a different question — what changes about **serving** once the
unit of work is a *loop* (one agent, many turns) or a *topology* (many agents, fan-out)?
Caching, backpressure, and circuit-breaking are old single-call serving concerns. The sibling
guide `study-ai-engineering/06-production-serving/` teaches them at the call level; this
section only covers the *agent angle* — what each becomes when you multiply it by N turns or N
agents, and CROSS-REFERENCES the call-level mechanics rather than re-teaching them.

## Where this section sits

```
  buffr's stack — Section E wraps the loop with serving controls

  ┌─ SERVING CONTROLS (Section E) ─ how the loop is SERVED ─────────┐
  │  cross-turn cache · fan-out backpressure · per-tool breaker    │
  │ ┌─ ★ THE AGENT LOOP (Sections A–D) ★ ─────────────────────────┐ │
  │ │  step → model.complete → execute tool → accumulate → stop   │ │
  │ │  N turns, each re-sending the stable prefix at the FRONT    │ │
  │ └─────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────┘
   ┌─ the one tool ─────────────────────────────────────────────────┐
   │  search_knowledge_base → local pgvector (the flaky dependency) │
   └────────────────────────────────────────────────────────────────┘
```

The single-call versions of all three controls are upstream knowledge. The agent versions
differ because a loop *re-pays* the cost on every turn and *re-hits* the dependency on every
tool call — so a cache miss, an over-spawn, or a dead tool compounds across the iteration
budget instead of failing once.

## The state of play for buffr — be honest

buffr serves **one user on one device against a LOCAL Ollama** (`gemma2:9b` +
`nomic-embed-text`). No provider rate limit. No concurrency. No fan-out. So most of this
sub-section is **NOT YET / minimal** for buffr — and that is the honest read, not a gap to
apologize for. You serve a fleet against a billed API before these earn their keep. What buffr
*does* have:

- **The warm pg pool** (`session.ts:39,73`) — one `Pool` held across every turn, the
  connection-reuse serving win. This is real and implemented.
- **Tool-result truncation** (`run-agent-loop.ts:52-57`, `MAX_TOOL_RESULT_CHARS=16000`) — a
  serving control that caps what a tool result can inject back into context.
- **Error-as-observation** (`run-agent-loop.ts:163-187`) — the loop catches a tool throw and
  feeds it back as an observation. That is the *substrate* a circuit breaker would build on,
  but the open/half-open state machine is not wired.

Everything else here is taught as study material with buffr's would-need named explicitly.

## Reading order

```
  01-cross-turn-caching.md       ← what CACHING becomes across N turns + N runs   [shape YES, billed cache NOT YET]
        │                           prefix cache · intra-run memo · cross-run semantic
        ▼
  02-fan-out-backpressure.md     ← what BACKPRESSURE becomes with a supervisor    [NOT YET — no fan-out]
        │                           the concurrency cap (semaphore) · upward pressure
        ▼
  03-per-tool-circuit-breaking.md ← what BREAKING becomes scoped to ONE tool       [substrate YES, breaker NOT YET]
                                    error-as-observation · open/half-open state machine
```

Read 01 first — it carries the reframe the rest rests on: in a loop the *stable part* of the
request sits at the front of every turn, which is the prompt-prefix-cache shape whether or not
your provider bills for it. Read 03 last; it is where a single-call control (the breaker) only
makes sense once you accept the loop will *re-hit* a dead dependency until the budget burns.

## The one-line anchor for this section

buffr is a **single-agent, single-device, local-Ollama** system, so each serving concern here
has a single-agent shape *and* a fleet shape — and the file names both. Caching for one local
loop is a free prefix shape buffr can't bill; for a fleet on a billed API it is real money
saved per turn. Backpressure for one agent is nothing (one model, no rate limit); for a
supervisor over-spawning sub-agents it is a semaphore plus upward pressure. Circuit-breaking
for one read-only tool is an error fed back as an observation; for a fleet hammering a shared
flaky dependency it is a state machine that routes the whole loop around the dead tool. buffr
ships the warm pool and the truncation cap. The rest is named so you can defend why buffr does
not need it yet — and exactly what would flip each one on.

## Cross-links to sibling guides

This section covers the *agent-architecture angle* only. The call-level mechanics live in the
sibling guide — do not re-teach them here:

- **`study-ai-engineering/06-production-serving/`** — the single-call versions: prompt caching
  mechanics and billing, backpressure / rate-limit handling, the circuit-breaker state machine
  at the call level. Each file in this section points back to it for the primitive.
- **`study-ai-engineering/01-llm-foundations/06-token-economics.md`** — why prefix caching is
  money, the per-token cost model a cache hit avoids.
- **`../03-multi-agent-orchestration/`** — Section C, where fan-out topologies live; file 02
  here is the *serving* view of the parallel topology taught there.
- **`../06-orchestration-system-design-templates/`** — Section F, the research-assistant
  template where fan-out backpressure becomes a real design requirement.

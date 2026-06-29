# Shared state and message passing — how agents communicate

**Industry name(s):** shared state / blackboard · message passing ·
context routing · agent communication models. **Type label:** Industry
standard.

**In this codebase: Not yet implemented (one agent, nobody to
communicate with) — but buffr already has a blackboard at the data
layer.** There are no inter-agent messages because there's one agent.
The interesting anticipation: the `chunks` table is effectively a
shared blackboard (docs + memory, all agents-to-be would read it), and
the trace `messages` are a one-writer log.

## Zoom out, then zoom in — lead with the shape

```
  Two communication models (lead with both)

  Shared state (blackboard):       Message passing:
  ┌──────────────────────┐        agent A ──msg──► agent B
  │   shared context      │        agent B ──msg──► agent C
  │  (all agents read      │        (each agent sees only
  │   and write here)      │         what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

Zoom in: shared state is a blackboard every agent reads and writes —
simple, but everyone sees everything. Message passing scopes each
agent's context to what it's handed — cheaper and less noisy, but you
have to decide what to pass, and a bug there means an agent acts on
missing information.

## Structure pass

**Layers.** The communication layer between agents. In shared state it's
one store; in message passing it's the edges between agents.

**Axis — "what does each agent see?"** Shared state: everything.
Message passing: only what's routed to it. That single difference drives
the cost (context bloat vs routing complexity) and the failure modes.

**Seam.** In shared state, the seam is the blackboard's read/write
contract. In message passing, the seam is each message — what one agent
chooses to pass to the next. The message seam is where an agent gets
starved of context it needed.

## How it works

#### Move 1 — the mental model

You know the two ways React components share data: lift state into a
shared store everyone reads (context/Redux), or pass props down to
exactly who needs them. Shared state is the store; message passing is
props. Same tradeoff: the store is simple but global; props are scoped
but you have to thread them.

```
  Pattern — blackboard vs props

  blackboard:  one store, all read/write  → simple, but global noise
  messages:    A passes scoped data to B  → scoped, but threading bugs
```

#### Move 2 — the walkthrough (buffr's data-layer blackboard)

**buffr already has a blackboard — the `chunks` table.** Documents and
conversation memory both live there (`src/session.ts:50-53`), recalled
by any reader through the same `search_knowledge_base` tool. If buffr
grew workers, they'd all read this one store — a classic blackboard. The
memory engine's over-fetch-then-filter-by-kind
(`conversation-memory.js:48-53`) is the blackboard's "read what's
relevant to me" pattern.

**buffr's trajectory is a one-writer log, not multi-agent messaging.**
The `messages` table captures every step of the *single* agent's run
(`src/supabase-trace-sink.ts:49-94`). That's persistence/observability,
not agents talking to each other — there's one writer. Multi-agent
message passing would make `messages` (or a new table) a channel
*between* agents, with each agent reading only the messages addressed to
it.

**The tradeoff that decides the production answer.** Shared state is
simple to reason about, but every agent sees everything — so context
bloat and the lost-in-the-middle problem *scale with the number of
agents*. Message passing scopes each agent's context (cheaper, less
noise) but requires deciding what to pass, and a bug there starves an
agent. The production answer is multi-agent context *routing*: pass
role-specific context to each agent — which is a direct application of
SECTION D's context engineering
(`04-agent-infrastructure/01-context-engineering.md`).

```
  Comparison — buffr's data-layer state vs would-be agent comms

  buffr today:                     multi-agent (would-be):
    chunks = shared blackboard       blackboard for knowledge (keep)
    messages = 1-writer trace log    + message routing between agents
    (no agent-to-agent comms)        + role-specific context per agent
```

#### Move 3 — the principle

Shared state is simple but global; message passing is scoped but
requires threading. As agents multiply, shared state's "everyone sees
everything" turns into context bloat — so production systems route
role-specific context to each agent rather than dumping a shared
blackboard into every prompt. buffr already separates a shared knowledge
blackboard (`chunks`) from a per-run log (`messages`); the multi-agent
upgrade is adding *routed* messaging on top, not replacing the
blackboard.

## Primary diagram

```
  Communication models (buffr's data layer marked)

  buffr's chunks table  = shared BLACKBOARD (docs + memory, all read)
  buffr's messages table = one-writer TRACE log (not agent messaging)

  would-be multi-agent:
    knowledge → blackboard (shared)
    coordination → message passing (routed, role-specific context)
```

## Elaborate

The blackboard model is an old AI architecture (Hearsay-II, 1970s):
specialists collaborate by reading and writing a shared workspace.
Message passing is the actor-model lineage: scoped, explicit channels.
Real multi-agent systems use both — a shared store for durable knowledge
and routed messages for coordination — which is exactly the split buffr
already has at the data layer (`chunks` shared, `messages` per-run). The
context-bloat hazard of over-sharing is the bridge to context
engineering and the coordination-failure-modes file.

## Interview defense

**Q: How would agents share state in buffr's multi-agent future?**
buffr already has the split: `chunks` is a shared blackboard (docs +
memory, read by anyone via the search tool), and `messages` is a
one-writer trace log. The multi-agent upgrade is routed message passing
on top — pass role-specific context to each agent rather than dumping
the whole blackboard into every prompt, because shared-everything
context bloat scales with the agent count.

```
  knowledge → blackboard (shared) | coordination → routed messages
```

**Anchor:** "Shared state is simple but global; route role-specific
context as agents multiply, or context bloat scales with them."

## See also

- `04-agent-infrastructure/01-context-engineering.md` — context routing
  is its application
- `09-coordination-failure-modes.md` — context bloat as a failure mode
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the shared
  `chunks` blackboard as memory
- `.aipe/study-system-design/03-trajectory-capture.md` — the `messages`
  log

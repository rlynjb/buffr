# Shared State and Message Passing

*Industry names: **blackboard** (shared state) vs **message passing** (scoped channels) / **agent communication**. Type label: Industry standard. In this codebase: **Not yet implemented** (one agent has no peer to share with). But buffr's `messages` array is the single-agent analogue of shared state.*

## Zoom out, then zoom in

This is not a topology — it's the *plumbing under* every topology: how agents share information.
Two shapes. Here they are first.

```
  THE TWO SHAPES — how agents share data (★ = where the data lives)

  BLACKBOARD (shared state)              MESSAGE PASSING (scoped channels)
  ┌──────────────────────────┐          ┌────────┐  msg   ┌────────┐
  │  ★ ONE shared state blob  │          │ AGENT A │──────▶│ AGENT B │
  │  A,B,C all read + write   │          └────────┘        └────────┘
  └──┬──────┬──────┬──────────┘             A sends B ONLY what B needs
     A      B      C                        (no global blob; scoped context)
  everyone sees everything                 each agent sees a SUBSET
  → risk: CONTEXT BLOAT                    → benefit: SCOPED context, less bloat
```

The shape is the mental model: **one global blackboard everyone reads/writes, versus point-to-
point messages carrying only what each recipient needs.** The honest sentence: buffr has one agent,
so there's no inter-agent sharing at all. But its accumulating `messages` array *is* shared state
for one agent — the single-agent analogue this file anchors to.

## Structure pass

One axis: **state** — how wide is each agent's view, and where does context bloat come from?

```
  Axis = STATE (visibility) · the SEAM is whether each agent sees EVERYTHING or a SUBSET

  blackboard       every agent reads the WHOLE shared state every time it runs
  ──────────── ★ SEAM: visibility narrows from ALL to SCOPED ★ ──────────
  message passing  each agent receives only the messages addressed to it (a subset)
```

This seam *is* the cost story. A blackboard is simple — one place, everyone reads it — but it
grows without bound, and every agent pays to re-read the whole thing on every call (that's context
bloat: bigger prompts, higher cost, slower, and eventually the model loses the signal in the
noise). Message passing scopes each agent's view to what it needs, keeping contexts small — at the
cost of routing complexity (who sends what to whom). The seam is visibility: all vs. subset, and
it's the dominant lever on multi-agent cost.

## How it works

### Move 1 — mental model

Two ways agents communicate: a shared whiteboard, or sealed envelopes. Bridge from frontend: the
blackboard is a global store (one big Redux/context object every component reads); message passing
is props drilled to exactly the child that needs them. You already know the trade — global store is
easy but everything re-renders on every change; scoped props are more wiring but each component
only sees its slice.

```
  THE SHAPE — global store vs scoped props (the same trade you know)

  BLACKBOARD = global store         MESSAGE PASSING = scoped props
  ┌─ store ─┐                       parent ──{onlyWhatChildNeeds}──▶ child
  │ {all}   │◀── A,B,C all read     no global blob; each hop carries a subset
  └─────────┘    + write
  easy, but grows + everyone        more wiring, but contexts stay small
  re-reads everything (bloat)
```

### Blackboard — one shared state, and the context-bloat trap

Every agent reads and writes one shared object. Simple to wire, and it's what graph orchestration
(`07`) checkpoints. The trap: the blob accumulates every agent's output, so each agent's prompt
grows with the whole run's history — even the parts irrelevant to it.

```
  Blackboard — shared blob grows, every agent re-reads ALL of it

   turn 1: state = {A's output}                    ← small
   turn 2: state = {A's output, B's output}         ← bigger
   turn 3: state = {A's, B's, C's output}           ← every agent now re-reads ALL three
            └── CONTEXT BLOAT: cost ↑, latency ↑, signal lost in noise ──┘
```

Annotation: context bloat is the blackboard's signature failure (and a coordination failure in
`09`). The mitigation is to *scope* — don't hand every agent the whole blob; pass each only its
slice. That's message passing.

### Message passing — scoped channels, smaller contexts

Each agent sends another agent only what it needs. No global blob; visibility is narrowed per hop.
More routing wiring, but each agent's context stays small and on-topic.

```
  Message passing — A sends B only B's slice

   A ──{retrieved chunks B needs}──▶ B   (B never sees A's reasoning, just the chunks)
   B ──{B's conclusion}──▶ C             (C never sees the raw chunks, just B's conclusion)
        each agent's prompt = its task + its inbox, NOT the whole run history
```

Annotation: the win is bounded per-agent context regardless of run length. The cost is you now
design the channels — who needs what — which is exactly the routing the blackboard let you skip.
Most mature systems use a blackboard for *durable* state (checkpointing) plus message passing for
*per-agent* context, taking the best of both.

### buffr's single-agent analogue — the `messages` array IS shared state

buffr has no peers, but its accumulating `messages` array is the one-agent version of a
blackboard: one growing object the single agent reads in full every turn.

```ts
// run-agent-loop.ts:94,124,189 — the messages array: one agent's "shared state"
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];  // :94  seed
messages.push({ role: 'assistant', content: response.content });            // :124 grows
messages.push({ role: 'user', content: toolResults });                      // :189 grows more
// every turn, model.complete(messages) re-reads the WHOLE array — single-agent context growth
```

```
  buffr's messages array = a one-agent blackboard

   turn 1: [user]
   turn 2: [user, assistant, tool_result]
   turn 3: [user, assistant, tool_result, assistant, tool_result]
            └── model re-reads ALL of it each turn (bounded by maxTurns:6, maxToolCalls:4) ──┘
```

Annotation: this is the bridge — buffr's `messages` array is *exactly* a blackboard with one
reader/writer. The context growth is real but *bounded* by buffr's caps (`maxTurns:6`,
`maxToolCalls:4`, `rag-query-agent.ts:75-76`) and the 16k tool-result truncation
(`run-agent-loop.ts:52-57`). Multi-agent shared state has the same growth but with *N* writers and
no single budget bounding it — which is why context bloat is a multi-agent failure (`09`) and only
a managed-cost in buffr.

### Move 3 — the principle

**Blackboard is easy but bloats; message passing scopes context at the cost of routing — and the
visibility choice is the dominant lever on multi-agent cost.** Use a blackboard for durable state
you checkpoint (`07`), but scope each agent's *prompt* via message passing so contexts don't grow
with the whole run. The single-agent version of this discipline is already in buffr: bounded turns
and truncated tool results keep its one-agent blackboard from bloating. Multi-agent just makes the
same problem N times bigger and unbounded by a single budget.

## Primary diagram

Full recap: the two shapes, the bloat seam, buffr's analogue, the verdict.

```
  Shared state vs message passing — the plumbing under every topology

  BLACKBOARD                          MESSAGE PASSING
  one blob, all read/write            scoped: each agent gets a subset
  simple · CONTEXT BLOAT risk         more routing · contexts stay small
  (good for durable checkpoint)       (good for per-agent prompts)
  ───────────────────────────────────────────────────────────────
  buffr analogue: the messages array (run-agent-loop.ts:94,124,189)
    = a ONE-agent blackboard, bounded by maxTurns:6/maxToolCalls:4 + 16k truncate
  multi-agent: NOT YET · same growth, N writers, no single budget
  refactor template: SECTION F · stateful-graph + scoped-context templates
```

Verdict in one line: **the visibility choice (global blackboard vs scoped messages) is the main
cost lever; buffr's `messages` array is a bounded one-agent blackboard — the multi-agent version is
not yet built.**

## Elaborate

The blackboard pattern is a classic AI architecture (the original Hearsay-II speech system);
message passing is the actor-model lineage. In modern agent stacks they coexist: LangGraph's state
object is a blackboard the checkpointer persists, while frameworks add scoped sub-agent contexts so
a worker doesn't inherit the supervisor's entire history. The production lesson is context bloat:
the naive "give every agent the full shared state" approach makes prompts grow with run length,
spiking cost and degrading quality (the model loses the relevant bit in a wall of irrelevant
history) — so mature systems scope aggressively, passing each agent only its slice. buffr
demonstrates the bounded single-agent version: caps plus truncation keep its one blackboard from
ever bloating, which is the same discipline scaled down to N=1.

To adopt scoped multi-agent state for buffr, see SECTION F's stateful-graph and scoped-context
templates — they show a checkpointed blackboard for durability plus per-agent message passing for
small contexts.

## Interview defense

**Q: "How do agents share information, and where does it go wrong?"**

Model answer: "Two shapes. A *blackboard* is one shared state blob every agent reads and writes —
simple, and it's what a graph checkpoints, but it bloats: every agent re-reads the whole run
history, so prompts grow, cost spikes, and the model loses the signal. *Message passing* scopes it
— each agent gets only its slice — smaller contexts at the cost of routing wiring. Most systems use
both: blackboard for durable checkpointed state, messages for per-agent prompts. buffr is one
agent, so there's no inter-agent sharing — but its `messages` array (`run-agent-loop.ts:94,124,189`)
is exactly a one-agent blackboard: it grows every turn and the model re-reads all of it. The
difference is buffr *bounds* it — `maxTurns:6`, `maxToolCalls:4`, 16k truncation — so it never
bloats. Multi-agent has the same growth with N writers and no single budget, which is why context
bloat is a multi-agent failure and only a managed cost in buffr."

```
  The defense in one picture

  blackboard: one blob, all read → CONTEXT BLOAT      message passing: scoped → small contexts
  buffr: messages array = bounded one-agent blackboard (caps + truncation)
```

Anchor: *Blackboard bloats, message passing scopes — the visibility choice is the main cost lever;
buffr's `messages` array is a bounded one-agent blackboard, the single-agent analogue of shared
state.*

## See also

- `07-graph-orchestration.md` — the graph checkpoints the shared state described here.
- `09-coordination-failure-modes.md` — context bloat as a coordination failure + its mitigation.
- `04-parallel-fan-out.md` — the merge is where shared state often bloats (concatenating branches).
- `../04-agent-infrastructure/` — context engineering and the memory tiers (where state persists).
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the `messages` array as ACCUMULATE.
- `../06-orchestration-system-design-templates/` (SECTION F) — scoped-context refactor.

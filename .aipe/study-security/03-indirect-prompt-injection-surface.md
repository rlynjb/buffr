# Indirect prompt-injection surface

**Industry name(s):** indirect / second-order prompt injection
(retrieval-borne, OWASP LLM01). **Type:** Industry standard.

## Zoom out, then zoom in

When the agent searches the knowledge base, the passages it gets back
are pasted into the model's context as tool results. The model can't
fully tell "this is data I retrieved" from "this is an instruction I
should follow." So any text that ends up indexed — *and now any earlier
conversation turn that got remembered* — is a place an attacker could
plant instructions that re-enter the prompt later. That's the surface.

```
  Zoom out — where injected text can ride in

  ┌─ Provider (Ollama) ─────────────────────────────────────────────┐
  │  gemma2:9b reasons over: system + question + TOOL RESULTS         │
  │                                              ▲                    │
  └──────────────────────────────────────────────┼───────────────────┘
                          tool result re-enters   │  ← injection rides here
  ┌─ Service (agent + tool) ─────────────────────┼───────────────────┐
  │  search_knowledge_base  ──returns chunks──────┘                   │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ vector search
  ┌─ Storage (Postgres) ──────▼──────────────────────────────────────┐
  │  chunks: indexed docs  +  memory rows (kind='memory') ★ both ★    │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is *untrusted content re-entering the prompt as
if it were trusted context*. The thing to understand — and the reason
this is a **low-severity** finding, not an alarm — is that buffr never
relies on the model *not* being injected. It relies on the model not
being able to *do* anything if it is. The defense isn't a content
filter; it's the two controls in `04` (one read-only tool, bounded
budget). This file names the surface honestly so the next person knows
exactly when it stops being low-severity.

## The structure pass

**Layers:** storage (where poisoned text would sit) → service (the
search tool that fetches it) → provider (the model that reads it as
context). The injection travels *up* the stack as a tool result.

**Axis — trust.** Trace "is this text data or instructions?":

```
  axis traced = "data, or instructions?"

  ┌─ retrieval ──────────┐  seam: tool result   ┌─ model context ─────┐
  │ chunk text = DATA    │ ════════╪═══════════► │ chunk text = ???    │
  │ (we know it's a doc) │  (it SHOULD flip but  │ model can't tell    │
  │                      │   there's no gate)    │ data from command   │
  └──────────────────────┘                       └─────────────────────┘
       ▲                                                ▲
       └──── the boundary that has no enforcement ──────┘
             → no delimiting, no instruction-stripping
```

**Seam:** the tool-result-to-context handoff. This is the seam where a
content gate *would* live — and doesn't. The audit's honest gap (lens
7) is precisely that this seam has no enforcement. The reason that's
acceptable lives one file over: the model's *capabilities* are gated
even though its *context* isn't.

## How it works

You know the RAG shape from AdvntrCue: retrieve → augment → generate.
Indirect injection is the dark side of the "augment" step — whatever
you retrieve becomes part of the prompt, so whatever an attacker can
get *into* your index, they can get into your prompt.

```
  The pattern — the poisoned-recall loop

   turn 1: attacker plants text          turn N: it comes back
   ┌─────────────────────────┐           ┌─────────────────────────┐
   │ a doc (or a chat turn)  │           │ search returns it as a  │
   │ containing:             │  ──embed──►│ tool result; model      │
   │ "ignore prior instrns"  │   stored   │ reads it as context     │
   └─────────────────────────┘           └───────────┬─────────────┘
            stored in chunks                          │ model MIGHT comply
                                                      ▼
                                            BUT: 1 read-only tool,
                                            4-call budget → can't ACT
```

### The kernel — what makes this a *surface* vs a *breach*

Two parts decide the severity, and only the first is new:

1. **The re-entry path** — present, and now wider. Retrieved text
   re-enters the prompt as a tool result. `PgVectorStore.search`
   returns `meta.text` from the `content` column (`src/pg-vector-store.ts:80-84`),
   the search tool hands that to the model. The surface used to be just
   indexed documents. **It now includes recalled conversation memory**
   — memory rows live in the same `chunks` table tagged
   `meta.kind='memory'` (`@aptkit/memory`, written via
   `src/session.ts:53`) and resurface through the *same*
   `search_knowledge_base` tool. So a poisoned earlier turn that got
   remembered can come back as retrieved content. *Breaks the
   assumption "retrieved text is inert" — there's no gate that
   re-asserts it.*
2. **The capability ceiling** — present, and it's what caps the damage.
   Even a fully-complied injection can only make the model *search
   again* or *write a bad answer*. There's no write tool, no exec, no
   network egress to redirect (see `04`). *This is the part that turns
   a breach into a wrong answer.*

Lose part 2 and this becomes severe. Keep it and the worst case is a
misleading response — annoying, not dangerous.

### The widening: memory closes the loop

This is the detail worth slowing on, because it's the recent change.
Before memory, the only injectable content was documents *you* chose to
index — a curated corpus. Now the agent *writes back* into the same
store every turn (`src/session.ts:64`):

```
  await memory.remember({ conversationId, question, answer });
```

`remember` embeds the exchange and upserts it as a `chunks` row tagged
`kind='memory'` (`@aptkit/memory` conversation-memory). On a later
turn, `recall`/`search` over-fetches (`k*4`) and the memory rows
compete with documents for the top-k slots. So the injection loop is
now *self-priming*: text the model produced (possibly while injected)
becomes retrievable context for future turns. On a single-user laptop
the only person who can poison your memory is you — which is why the
blast radius stays low — but the *mechanism* is now a closed loop, and
that's worth stating plainly.

### Why no content gate yet — and the trigger to add one

There's no delimiting of retrieved text, no instruction-stripping, no
separate data channel. That's a real gap (audit lens 7). It's
acceptable because the capability ceiling makes injection low-value:
you'd be spending an attack to get a wrong answer. The trigger to add a
gate is the same as everywhere else in this repo — **the day the agent
gets a second, non-read-only tool.** The moment the model can *act* on
injected instructions, the content seam needs a gate (delimit
retrieved text, mark it as untrusted data, strip imperative content).
Building it before that is defending a door with nothing behind it.

### The principle

The durable defense against indirect injection isn't sanitizing the
content — you can't reliably detect "instructions" in natural language.
It's *constraining what compliance can accomplish*. buffr is the clean
version of this: assume the model *will* be injected eventually, and
make sure that when it is, the blast radius is bounded by the tool
scope, not by your ability to filter prose. Capability-gating beats
content-gating because capability is enumerable and prose isn't.

## Primary diagram

The full surface: where text enters the index, how it re-enters the
prompt, and the ceiling that caps the damage.

```
  Indirect prompt-injection surface — buffr-laptop

  ┌─ Storage (Postgres / chunks) ───────────────────────────────────┐
  │  indexed documents  +  memory rows (kind='memory')               │
  │  ▲ writes: index-cmd (docs) · memory.remember (every turn)       │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ search returns meta.text as a hit
  ┌─ Service (agent loop) ────▼──────────────────────────────────────┐
  │  search_knowledge_base → tool result → model context             │
  │  ★ no content gate at this seam (the honest gap) ★               │
  │  CEILING: 1 read-only tool · maxTurns 6 · maxToolCalls 4 ─────────┼─ caps damage
  └───────────────────────────┬──────────────────────────────────────┘
                              │ context (system + question + results)
  ┌─ Provider (Ollama gemma2) ▼──────────────────────────────────────┐
  │  model may COMPLY with injected text → but can only search/answer │
  │  → worst case: a wrong answer, not an action                      │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Indirect prompt injection is the retrieval-borne cousin of the direct
"ignore your instructions" attack — direct injection is in the user's
message; indirect injection is in the *content the system fetches on
the user's behalf*, which is far harder to police because it arrives
from a trusted-looking internal channel (your own index). It's OWASP
LLM01 and there's no clean fix — the research consensus is that you
combine partial content defenses (delimiting, marking) with hard
capability limits, and lean on the capability limits as the real wall.
buffr leans entirely on capability limits right now, which is the
correct call while the agent has one read-only tool. The interesting
near-future wrinkle is the memory loop: episodic memory turns a
stateless RAG agent into one with a feedback channel, and feedback
channels are where injection gets durable. Worth re-auditing this lens
the moment memory writes become shared across tenants.

The deep walk of the agent loop and tool registry that *bounds* this
surface belongs in agent-architecture (not yet generated in this repo
— it'll be the home for the `runAgentLoop` mechanics). This file owns
the *trust* read; that guide will own the *control-flow* read.

## Interview defense

**Q: Your agent retrieves documents and conversation memory into the
prompt. How do you stop prompt injection?**

I don't stop the model from being *injected* — I stop injection from
*mattering*. The agent has one read-only tool and a 4-call budget, so
even if a retrieved passage says "ignore your instructions and do X,"
there's no X it can do: no write tool, no exec, no exfil channel. The
worst outcome is a wrong answer. I deliberately don't have a content
filter yet because filtering prose for "instructions" is unreliable,
and the capability ceiling makes injection low-value. I'd add a content
gate the moment the agent gets a tool that can act.

```
  injected? maybe.  can act on it? no.  → bounded blast radius
  1 read-only tool + 4-call budget = the wall
```

Anchor: *capability-gating beats content-gating — assume injection,
bound the consequence.*

**Q: Memory writes the model's own output back into the store. Doesn't
that create a feedback loop?**

Yes — and naming it is the point. Memory closes the injection loop: a
turn the model produced becomes retrievable context later. On a
single-user laptop the only person who can poison your memory is you,
so the blast radius stays low, but the mechanism is now self-priming. I
flag it explicitly so that when memory becomes multi-tenant, this lens
gets re-audited and a content gate goes in alongside the tenant
controls.

Anchor: *episodic memory turns stateless RAG into a feedback channel —
re-audit when it's shared.*

## See also

- `audit.md` — lens 7 (llm-and-agent-security), the honest "no content
  gate" gap.
- `04-least-privilege-tool-scope.md` — the capability ceiling that
  makes this surface low-severity.
- `01-parameterized-sql-boundary.md` — confirms memory writes add no
  new SQL sink (they reuse the parameterized upsert).
- `../study-system-design/` — the retrieval pipeline + memory
  architecture this rides on.

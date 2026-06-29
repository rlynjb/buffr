# ReAct — the pattern buffr actually runs

**Industry name(s):** ReAct (Reason + Act) · the
Thought–Action–Observation loop · the default single-agent pattern.
**Type label:** Industry standard.

## Zoom out, then zoom in

ReAct is the specific reasoning pattern buffr's loop instantiates.
This file's job is *placement* — where ReAct sits in the family and
why you start here before reaching for anything fancier — not to
re-teach the Thought–Action–Observation mechanics (those are loop
mechanics, walked in `02-agent-loop-skeleton.md`).

```
  Zoom out — ReAct in the reasoning-pattern family

  ┌─ Reasoning patterns (SECTION A) ─────────────────────────┐
  │                                                          │
  │   ★ ReAct ★  ← the baseline; buffr is here               │ ← we are here
  │      │ escalate only on a specific measured failure      │
  │      ├──► plan-and-execute  (structured tasks)           │
  │      ├──► reflexion         (quality via self-critique)  │
  │      └──► tree-of-thoughts  (rarely worth it)            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: ReAct interleaves reasoning and action — the model thinks,
acts (calls a tool), observes the result, and repeats. buffr's
`RagQueryAgent` is a textbook single-tool ReAct agent: the one action
available is "search the knowledge base."

## Structure pass

**Layers.** ReAct is one layer of the stack — it's *how the step
function is prompted* inside the loop kernel from the previous file.

**Axis — "what tells the model how to act?"** In a native-tool model,
the provider's tool API does. In buffr, the *system prompt* does — the
DEFAULT_SYSTEM_TEMPLATE says "Always call the search_knowledge_base
tool first to retrieve relevant passages before answering"
(`rag-query-agent.js:12-19`). That prompt is the ReAct scaffold.

**Seam.** The seam is between the model's emitted intent and the
harness — already covered in the skeleton file. Here the interesting
thing is the *prompt* seam: the system prompt is what makes Gemma
behave as a ReAct agent at all, because Gemma has no native ReAct
training for tools.

## How it works

#### Move 1 — the mental model

You know how a `useEffect` with a dependency re-runs, observes the new
state, and decides what to do next? ReAct is that loop with a brain in
the middle: think → act → observe → think again, until the thinking
concludes "I have my answer."

```
  Pattern — ReAct interleave (buffr's single-tool variant)

  Thought:  "the user asked about X; I should search for X"
     │
     ▼
  Action:   search_knowledge_base({ query: "X" })
     │
     ▼
  Observation: [ranked chunks with citations]
     │
     ▼
  Thought:  "that's enough — I can answer"  ──► final answer
            (or "not enough" ──► loop, capped at 4 calls)
```

#### Move 2 — the walkthrough

**buffr's ReAct is single-tool.** Most ReAct diagrams show a model
choosing among many tools. buffr deliberately has *one*:
`search_knowledge_base`, granted by `ragQueryToolPolicy`
(`rag-query-agent.js:8-11`). So the "Action" half of ReAct collapses
to a single choice: search, or stop and answer. That's the smallest
possible ReAct — and it's correct, because the only external
capability this agent needs is retrieval.

**The prompt is the pattern.** Open `rag-query-agent.js:12-19`. The
DEFAULT_SYSTEM_TEMPLATE is the ReAct instruction:

```js
const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');
```

"Always call the tool first" is the Reason→Act nudge. "Ground every
answer in the retrieved chunks" is the Observe→Reason nudge. This text
*is* what makes Gemma do ReAct — there's no native loop in the model.

**The Observation feeds back as a user message.** After the tool runs,
its result is pushed back into the message array as a `tool_result`
(`run-agent-loop.js:97-104`), so the model's next Thought sees the
retrieved chunks. That's the Observe step, mechanically.

```
  Layers-and-hops — one ReAct cycle in buffr

  ┌─ Model (gemma2:9b) ─┐ hop 1: tool_use JSON  ┌─ Harness ───────────┐
  │  Thought + Action   │ ───────────────────►  │  callTool           │
  │                     │                       │  → retrieval pipeline│
  │                     │ ◄───────────────────  │  → PgVectorStore     │
  └─────────────────────┘ hop 2: chunks (Obs.)  └─────────────────────┘
        next Thought loops on the observation, capped at 4 actions
```

#### Move 3 — the principle

Default to ReAct. It's the baseline single-agent pattern, and the
strong prior is to *start here* and escalate only when a measured
failure demands it.

```
  Pattern — the escalation gate

  Default to ReAct.
    │
    ├─ measure: success rate, tool-call accuracy, latency, cost
    │
    └─ escalate ONLY when a specific failure ReAct can't fix is found
       (a structured task ReAct re-plans badly → plan-and-execute;
        a quality gap a second pass would catch → reflexion)
```

Most teams jump past ReAct prematurely. "I built a ReAct baseline,
measured it, and escalated only when [specific failure]" is a stronger
answer than reaching for multi-agent first. buffr is the disciplined
case: it stays single-tool ReAct because nothing has measurably forced
it past that.

## Primary diagram

```
  buffr's ReAct agent (rag-query-agent.js + run-agent-loop.js)

  system prompt: "always search first, ground every answer"
        │
        ▼
  ┌─ ReAct loop (capped 6 turns / 4 calls) ──────────────────┐
  │  Thought ─► Action: search_knowledge_base ─► Observation  │
  │     ▲                                            │        │
  │     └──────────── loop on observation ───────────┘        │
  │  forced synthesis on last turn ─► grounded final answer   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct (Yao et al., 2022) was the insight that interleaving reasoning
traces with actions beats doing all the reasoning up front (pure
chain-of-thought) or all the acting with no reasoning. buffr's variant
is the retrieval specialization: the single action is search, which
makes it indistinguishable from "agentic RAG" — see
`02-agentic-retrieval/01-agentic-rag.md` for that framing (the reframe
to hold: all agentic RAG is agentic AI; not all agentic AI does
retrieval). Where buffr would escalate past ReAct: if a question
needed a *plan* across many sub-retrievals, plan-and-execute
(`04-plan-and-execute.md`) would beat re-deciding the whole approach
every turn — but buffr hasn't hit that ceiling.

## Interview defense

**Q: What reasoning pattern does buffr use, and why that one?**
Single-tool ReAct. The model interleaves reasoning and one action —
search the knowledge base — observing each result before deciding to
search again or answer. It's the right baseline because the only
external capability the agent needs is retrieval, so the action space
is genuinely one tool.

```
  Thought → Action(search) → Observation → Thought → answer
```

**Anchor:** "Single-tool ReAct — the action space is exactly one
read-only search, the smallest correct shape."

**Q: When would you escalate buffr past ReAct?**
Only on a measured failure ReAct can't fix. If questions needed a plan
across many sub-retrievals and ReAct kept re-deciding the approach
every turn, I'd reach for plan-and-execute. If answer quality had a
gap a second self-critique pass would catch, reflexion. Not before —
escalating without a measured failure just buys cost and a bigger
debug surface.

## See also

- `02-agent-loop-skeleton.md` — the loop ReAct runs inside
- `04-plan-and-execute.md` — the first escalation target
- `05-reflexion-self-critique.md` — the quality escalation target
- `02-agentic-retrieval/01-agentic-rag.md` — ReAct-with-retrieval, the
  same loop named from the retrieval side
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — how the
  Action half is emulated for Gemma
- ReAct *mechanics* would live in
  `study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`

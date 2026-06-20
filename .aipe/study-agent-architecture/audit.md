# Agent Architecture Audit — buffr

> Pass 1 of the two-pass audit. One section per lens. Each names what the
> codebase actually does with `file:line` grounding, or says **not yet
> exercised** honestly. Significant findings cross-link to a Pass 2 pattern
> file rather than restating it.

The repo's agent machinery is split across a boundary: buffr **wires and
persists**, `@rlynjb/aptkit-core` **runs the loop**. Paths under
`node_modules/@rlynjb/aptkit-core/node_modules/@aptkit/...` are the consumed
library; buffr never edits them (a stated must-not-change constraint,
`.aipe/project/context.md:49`). Library paths are abbreviated below as
`@aptkit/<pkg>/dist/src/<file>`.

---

## Lens 1 — Reasoning patterns (CoT / ReAct / plan-execute / reflexion / ToT)

**ReAct — exercised.** The agent runs a reason → act → observe loop. The model
emits either prose (done) or a tool call (act); the harness runs the tool and
feeds the result back as a `user` message of `tool_result` blocks, then loops.

- Loop body: `@aptkit/runtime/dist/src/run-agent-loop.js:25-105`.
- Reason: `model.complete(...)` at `run-agent-loop.js:29`.
- Act/observe: `tools.callTool(...)` at `run-agent-loop.js:76`, results pushed
  back at `run-agent-loop.js:104`.
- Termination on no-tool-use (success exit): `run-agent-loop.js:54-57`.

This is ReAct in the strict sense — interleaved reasoning and action with the
model choosing the next move each turn. → deep walk in `01-bounded-react-loop.md`.

**Plan-and-execute — not yet exercised.** No separate plan phase. The loop
re-decides every turn from scratch; there is no up-front step list, no
`plan: [...]` structure, no cheap-executor/expensive-planner split anywhere in
`RagQueryAgent` (`@aptkit/agent-rag-query/dist/src/rag-query-agent.js`).

**Reflexion / self-critique — not yet exercised.** No critic step, no
"is this correct?" turn, no retry-on-self-evaluation. The closest thing is
`runRecoveryTurn` (`run-agent-loop.js:116-138`), but that is a structured-output
*reparse* fallback, not a quality critique — and `RagQueryAgent` does not pass
`parseResult`/`recoveryPrompt`, so it never fires for buffr.

**Tree of Thoughts — not yet exercised.** No branching, no scoring, single path.

**Routing — not yet exercised as a distinct stage.** There is no heuristic or
LLM router in front of the agent. `ask-cmd.ts` sends every question straight
into the one agent. (The model's per-turn choice of *whether* to call the tool
is in-loop decision-making, not a routing stage.)

---

## Lens 2 — Agentic retrieval (agentic RAG / self-RAG / retrieval routing)

**Agentic RAG — exercised (the thin version).** Retrieval is a *tool the model
decides to call*, not a fixed pre-generation step. The system prompt instructs
"always call `search_knowledge_base` first"
(`rag-query-agent.js:14-18`), but the model is free to call it 0–4 times,
refine the query between calls, or answer from a prior result. That decision
loop is what makes it agentic rather than static RAG.

- Tool: `createSearchKnowledgeBaseTool` at
  `@aptkit/retrieval/dist/src/search-knowledge-base-tool.js:3-47`.
- Per-call query + top_k chosen by the model from the input schema
  (`search-knowledge-base-tool.js:10-27`).
- → deep walk in `03-agentic-retrieval.md`.

**Self-corrective RAG — not yet exercised.** No relevance grader between
retrieve and generate. Chunks come back and go straight into context; nothing
grades "relevant? grounded?" before synthesis. The only guard is defensive:
the tool's `matchesFilter` refuses to let a hallucinated filter key wipe all
results (`search-knowledge-base-tool.js:48-53`) — that protects recall, it does
not grade relevance.

**Retrieval routing — not yet exercised.** One source only: pgvector. No
router choosing between vector store / SQL / web. `app_id` scoping
(`PgVectorStore`, `src/pg-vector-store.ts`) is tenant filtering inside the one
source, not routing across sources.

---

## Lens 3 — Multi-agent orchestration

**Not yet exercised — by deliberate design.** buffr is a single agent. There is
no supervisor, no worker, no second `*Agent` instance, no handoff, no shared
blackboard, no message bus between agents. `ask-cmd.ts:33-34` constructs one
`RagQueryAgent` and calls `answer` once.

This is a stated decision, not an oversight. `agent-layer-plan.md:13-18`:
"a **single** RAG agent", "Not a fleet of agents. Ship ONE agent end-to-end,
measure it, then maybe generalize." The deferred two-brain (laptop + phone)
split lives in design docs only.

- When-not-to-go-multi-agent reasoning and the refactor that would adopt each
  topology: `06-orchestration-templates.md`.

Every SECTION C topology (supervisor-worker, pipeline, fan-out, debate,
swarm, graph, shared-state, coordination-failure-modes) is **not yet
exercised**. They are covered as study material in `06-orchestration-templates.md`,
each with the concrete buffr refactor that would adopt it.

---

## Lens 4 — Memory & state

**Working state (in-context) — exercised.** The loop's `messages` array is the
agent's state — it accumulates assistant turns and tool results across the run
(`run-agent-loop.js:22, 48, 104`). It is the thing that makes it a loop and not
N independent calls. Gone when the run ends.

**Trajectory persistence — exercised, but as a sink, not as recall.** Every
assistant `step` and every `tool_call_end` is written to
`agents.conversations` / `agents.messages` via `SupabaseTraceSink`
(`src/supabase-trace-sink.ts:27-36`). This is the project's real differentiator
(`agent-layer-plan.md:17` — "capture every conversation as a trajectory now so
fine-tuning is *answerable* later"). → `04-trajectory-as-memory.md`.

**Episodic / cross-session memory — not yet exercised.** Crucial honesty point:
buffr *persists* trajectories but never *reads them back* into a later run.
`ask-cmd.ts:29` calls `startConversation` fresh every invocation; nothing
retrieves prior conversations into the next question's context. The data is
write-only from the agent's perspective — a corpus for future fine-tuning, not
a memory tier the agent queries. → covered in `04-trajectory-as-memory.md` as
the Phase A / Phase B split.

**Long-term knowledge (the corpus) — exercised.** The indexed `documents` /
`chunks` are durable knowledge the agent retrieves over (pgvector HNSW). This is
RAG-as-knowledge, distinct from agent *memory* of past runs.

---

## Lens 5 — Control loop & termination

**Bounded loop with two exits — exercised, and this is the strongest part of
the architecture.**

- Turn cap: `maxTurns = 6` (`rag-query-agent.js:47`), enforced by the `for`
  loop bound (`run-agent-loop.js:25`).
- Tool-call budget: `maxToolCalls = 4` (`rag-query-agent.js:48`), checked at
  `run-agent-loop.js:27`.
- Success exit: model emits no tool_use → break with that text
  (`run-agent-loop.js:54-57`).
- Budget exit via **forced synthesis**: on the last turn or when the tool
  budget is spent, `forceFinal` strips the tool schemas (`tools: undefined`,
  `run-agent-loop.js:32`) and appends the synthesis instruction
  (`run-agent-loop.js:30`). The model *cannot* call a tool on that turn, so it
  must answer. `buildSynthesisInstruction` (`run-agent-loop.js:17-19`) is the
  "you have NO more tool calls available… Do not say you need more queries."
- Final fallback string if even that yields empty text:
  `rag-query-agent.js:51` (`FALLBACK_ANSWER`).
- Cancellation: an `AbortSignal` is threaded through and checked each turn
  (`run-agent-loop.js:26`, `signal?.throwIfAborted()`).

→ deep walk in `01-bounded-react-loop.md`. This is the load-bearing skeleton.

---

## Lens 6 — Capability scoping (least privilege)

**Exercised — tightest possible scope.** The agent's tool grant is an explicit
allowlist of exactly one read-only tool:

- `ragQueryToolPolicy.allowedTools = [SEARCH_KNOWLEDGE_BASE_TOOL_NAME]`
  (`rag-query-agent.js:8-11`).
- `filterToolsForPolicy` intersects the registry catalog with the allowlist
  before the model ever sees a schema (`@aptkit/tools/dist/src/tool-policy.js:2-11`,
  called at `rag-query-agent.js:37`).
- The one tool is read-only: it queries pgvector and returns chunks, no writes
  (`search-knowledge-base-tool.js:29-45`).

Even though buffr's registry only registers one tool anyway
(`ask-cmd.ts:24`), the policy is the *contract* that bounds the blast radius —
adding more tools to the registry would not widen the agent's reach without an
explicit allowlist change. → `02-single-tool-capability-scope.md`. Cross-links
to `.aipe/study-security/04-least-privilege-tool-scope.md`.

---

## Lens 7 — Agent infrastructure (context / tool-calling / eval / guardrails)

**Context engineering — exercised (profile-as-standing-context).** The user
profile (`me.md`-style) is loaded from `agents.profiles`
(`src/profile.ts:4-8`) and injected at the *front* of the system prompt before
template rendering (`injectProfile`, `@aptkit/context/dist/src/profile-injector.js:15-22`;
wired at `rag-query-agent.js:29-32`). Plus a context-window guard wraps the
provider (`ContextWindowGuardedProvider`, `ask-cmd.ts:26`, `maxTokens: 8192`).
→ `06`-template eval framing references this; deep walk of the injection seam
lives in `.aipe/study-system-design/06-profile-injection-as-context.md`.

**Tool calling — exercised, EMULATED.** Gemma 2 has no native tool API. The
Gemma provider renders tool schemas into system text and parses a JSON blob
back out, with a one-shot retry nudge for malformed JSON
(`@aptkit/provider-gemma/dist/src/gemma-provider.js:82-125`). This is the
mechanic that makes everything above it possible on a stock model.
→ `05-emulated-tool-calling.md`. MCP: **not yet exercised** (no MCP server,
direct tool definitions only).

**Agent evaluation — partially exercised.** buffr ships an eval CLI
(`src/cli/eval-cmd.ts`) and a labeled set (`eval/queries.json`) scoring
**precision@k** on retrieval. That is a *retrieval* eval, not a *trajectory*
eval — it does not score tool-call accuracy, step efficiency, or recovery rate.
Trajectory eval is **not yet exercised**, though the persisted trajectories
(`04-trajectory-as-memory.md`) are exactly the substrate it would need.

**Guardrails & control — partially exercised.** Strong on the loop envelope
(turn/tool caps, forced synthesis, abort — Lens 5) and on capability scoping
(Lens 6). Weaker on input/output guardrails: no input sanitization of the
user question, no output schema validation on the final answer (the agent
returns free prose). The indexed-content prompt-injection surface is real and
covered in `.aipe/study-security/03-indirect-prompt-injection-surface.md`.

---

## Lens 8 — Production serving for agents

**Cross-turn caching — not yet exercised.** No prompt-prefix cache, no intra-run
memoization of repeated `search` calls, no cross-run semantic cache. A repeated
identical query within a run re-hits pgvector. The plan names a tool-run cache
as a Phase-3 item (`agent-layer-plan.md:95`), not yet built.

**Fan-out backpressure — not applicable.** No fan-out: single agent, sequential
turns, one outbound model call at a time.

**Per-tool circuit breaking — not yet exercised.** A tool error is caught and
fed back to the model as an observation (`run-agent-loop.js:81-86, 97-102`),
which lets the model react — but there is no breaker state across turns. With
only `maxToolCalls = 4` the blast radius of a dead tool is naturally bounded to
4 failed calls, so a breaker buys little here. Worth naming as the control you'd
add if the tool count or budget grew.

---

## Summary table

| Lens                       | Status            | Anchor                                  |
| -------------------------- | ----------------- | --------------------------------------- |
| ReAct loop                 | exercised         | `run-agent-loop.js:25-105` → `01`       |
| Plan-execute / reflexion / ToT | not yet exercised | —                                   |
| Routing                    | not yet exercised | —                                       |
| Agentic RAG                | exercised (thin)  | `search-knowledge-base-tool.js` → `03`  |
| Self-RAG / retrieval routing | not yet exercised | —                                     |
| Multi-agent orchestration  | not yet exercised | design-only → `06`                      |
| Working state              | exercised         | `run-agent-loop.js:22,48,104`           |
| Trajectory persistence     | exercised         | `supabase-trace-sink.ts:27-36` → `04`   |
| Cross-session memory       | not yet exercised | persisted, never read back → `04`       |
| Control loop & termination | exercised (strong)| forced synthesis `run-agent-loop.js:17-32` → `01` |
| Capability scoping         | exercised (tight) | `rag-query-agent.js:8-11` → `02`        |
| Profile-as-context         | exercised         | `rag-query-agent.js:29-32`              |
| Tool calling               | exercised, EMULATED | `gemma-provider.js:82-125` → `05`     |
| MCP                        | not yet exercised | —                                       |
| Agent eval (trajectory)    | not yet exercised | retrieval eval only (`eval-cmd.ts`)     |
| Cross-turn cache / breaker | not yet exercised | bounded by 4-call budget                |

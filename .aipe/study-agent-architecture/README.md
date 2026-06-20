# Study — Agent Architecture (buffr)

Agent reasoning patterns, agentic retrieval, and orchestration as exercised by
**buffr** — the laptop "brain" of a self-hosted personal RAG agent. Generated
per `study-agent-architecture` spec, audit-style two-pass shape.

## The one-line verdict

buffr is a **single-agent, bounded ReAct loop** with one read-only tool
(`search_knowledge_base`) over stock Gemma 2:9b, via `@rlynjb/aptkit-core`.
buffr adds Postgres/pgvector persistence, trajectory capture, profile context,
and CLIs. It is **not** multi-agent (deliberately — see `agent-layer-plan.md`),
**not** a chain, and tool calling is **emulated** (prompt + parse) because Gemma
has no native tool API.

## Reading order

```
  00-overview.md                       ← start here: the whole system in one frame
       │
  audit.md                             ← Pass 1: every lens, file:line or "not yet exercised"
       │
  01-bounded-react-loop.md             ← the spine; read first among the patterns
  02-single-tool-capability-scope.md
  03-agentic-retrieval.md
  04-trajectory-as-memory.md
  05-emulated-tool-calling.md
  06-profile-as-standing-context.md
  07-orchestration-templates.md        ← SECTION F + the honest multi-agent "not yet" material
```

## The files

| File | What it covers | Shape |
| ---- | -------------- | ----- |
| `00-overview.md` | One-page orientation, the system diagram, the verdict | — |
| `audit.md` | Pass 1: 8 lenses, grounded or "not yet exercised" | — |
| `01-bounded-react-loop.md` | ReAct loop + turn/tool budget + **forced synthesis** | single-agent |
| `02-single-tool-capability-scope.md` | Allowlist policy → one read-only tool, small blast radius | single-agent |
| `03-agentic-retrieval.md` | Model decides whether/what to search vs static RAG | single-agent |
| `04-trajectory-as-memory.md` | Per-run capture to Postgres; **not** yet cross-session recall | single-agent |
| `05-emulated-tool-calling.md` | Prompt-render + JSON-parse tool calls on stock Gemma | single-agent |
| `06-profile-as-standing-context.md` | `me.md` profile injected into the system prefix | single-agent |
| `07-orchestration-templates.md` | 3 interview templates; multi-agent refactor targets | multi-agent (design-only) |

## What's "not yet exercised" (honest inventory)

buffr is one agent. These are taught as study material / refactor targets, not
current code:

- **Multi-agent orchestration** — no supervisor, worker, pipeline, fan-out,
  debate, swarm, graph, or handoff. Deliberate (`agent-layer-plan.md:13-18`).
  Refactor targets in `07-orchestration-templates.md`.
- **Plan-and-execute, reflexion/self-critique, tree-of-thoughts, routing** — no
  planner, critic, branching, or router stage (`audit.md` Lens 1).
- **Self-corrective RAG, query decomposition, retrieval routing** — single
  source, no relevance grader (`audit.md` Lens 2).
- **Cross-session memory** — trajectories are *written* but never *read back*
  into a later run (`04-trajectory-as-memory.md`, Phase A/B split).
- **MCP, trajectory eval, cross-turn caching, per-tool circuit breaking** —
  `audit.md` Lenses 7-8. (Retrieval eval *is* present: `src/cli/eval-cmd.ts`.)

## Honest framing on emulation

Tool calling on Gemma is **emulated** (prompt-render outbound, JSON-parse
inbound, one retry). The *agent-architecture* placement is in
`05-emulated-tool-calling.md`; the prompt-craft of reliable JSON and
structured-output evals are prompt-engineering / ai-engineering concerns,
cross-linked there, not re-taught.

## Cross-links to sibling guides

- **System design** (exists): `.aipe/study-system-design/` —
  `02-retrieval-pipeline.md` (RAG mechanics), `03-trajectory-capture.md` (sink
  write-path), `06-profile-injection-as-context.md` (injection seam).
- **Security** (exists): `.aipe/study-security/` —
  `03-indirect-prompt-injection-surface.md` (indexed-content injection),
  `04-least-privilege-tool-scope.md` (the allowlist threat model).
- **AI engineering** (sibling generator, not yet generated):
  `.aipe/study-ai-engineering/` — ReAct mechanics, tool-calling mechanics, RAG,
  structured outputs, agent memory. Cross-referenced by canonical path.
- **Prompt engineering** (sibling generator, not yet generated):
  `.aipe/study-prompt-engineering/` — structured-output / self-critique craft.

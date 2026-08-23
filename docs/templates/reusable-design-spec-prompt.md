# Reusable Design-Spec Prompt

Copy the prompt below into any coding agent. Replace only the request section.

````text
You are writing a design specification for an existing codebase.

Your job is to inspect the repository first, then produce one grounded design
specification. Do not implement code, create an implementation plan, modify
application behavior, or invent capabilities that do not exist in the repo.

Follow repository instructions first, including any AGENTS.md, CLAUDE.md, or
project documentation. Treat existing code, tests, architecture docs, and
recent git history as evidence. If an important product decision is genuinely
unknown, ask one concise question before writing the spec.

## Request

Create a design spec for:

<DESCRIBE THE FEATURE, INTEGRATION, OR ARCHITECTURAL CHANGE>

## Output location

Save the spec at:

docs/superpowers/specs/YYYY-MM-DD-<concise-topic>-design.md

Use today’s date and a concise kebab-case topic. If this repository uses a
different documented convention, follow that convention instead.

## Writing principles

- Explain what exists today before explaining what changes.
- State the problem, boundary, and rationale in plain language.
- Preserve clear seams: external systems, adapters, contracts, deterministic
  core, AI/agent boundary, persistence, and user-facing actions.
- Prefer a small vertical slice over premature generalization.
- Make non-goals explicit.
- Do not use TODO, TBD, vague placeholders, or “handle appropriately.”
- Never describe raw credentials, tokens, customer data, provider payloads, or
  private values in examples.
- Clearly distinguish implemented now, proposed by this spec, and intentionally
  deferred work.
- If AI is involved, keep deterministic routing, validation, and permissions
  outside the model. Require structured outputs and a human approval boundary
  before any production-changing action.

## Required document format

# <Feature Name> Design

**Date:** YYYY-MM-DD
**Status:** Proposed design, pending review
**Depends on:** <relevant existing specs, plans, or modules>

## Goal

State the concrete outcome in 1–3 paragraphs.

Immediately add an inline learning note when useful:

> **DDIA lens — <concept>:** Explain the relevant DDIA concept, define it in
> plain language, and say exactly how this design uses it.

## Why This Exists

Describe what is already implemented, what is missing or mismatched, why this
specific seam or capability is needed, and what is explicitly not being rebuilt.

## Scope

List the capabilities this design adds.

## Non-goals

List what remains out of scope, especially unrelated platforms or future
generalization, dashboards or UI not needed for the first slice, autonomous
writes or production changes, and raw-data warehousing when aggregates suffice.

## Architecture

### Terms and design patterns

Define project-specific terms and map them to established patterns.

| Pattern / term | Meaning in this design |
| --- | --- |
| Ports and adapters | ... |
| Anti-corruption layer | ... |
| Deterministic workflow orchestrator | ... |
| Human-in-the-loop approval | ... |

### ASCII architecture diagram

Include one readable ASCII diagram showing external source systems; adapters or
an integration boundary; normalized contracts or artifacts; deterministic core;
bounded AI or agent modules when applicable; persistence; human approval; and
the output or feedback loop.

```text
External systems
      |
      v
+---------------------------+
| Adapter / source boundary |
+-------------+-------------+
              |
              v
+---------------------------+
| Normalized evidence       |
| contracts + provenance    |
+-------------+-------------+
              |
              v
+---------------------------+
| Deterministic core        |
| routes, guards, storage   |
+-------------+-------------+
              |
              +----------------------------+
              |                            |
              v                            v
     Bounded agent modules         Human approval gate
              |                            |
              +-------------+--------------+
                            v
                    Manual action / result
                            |
                            v
                     Later evidence loop
```

After the diagram, explain ownership boundaries: which component owns data
collection, validation, interpretation, lifecycle routing, persistence, and
production actions.

Add learning notes inline where they fit naturally:

> **Fundamentals of Data Engineering lens — <concept>:** Explain the relevant
> data-engineering principle, such as ingestion, batch processing, data quality,
> lineage, orchestration, or analytical data products. State how the design
> applies it and why it matters.

> **AI Agents in Action lens — <concept>:** Explain the relevant agent-system
> principle, such as deterministic orchestration, bounded specialists,
> structured outputs, tool limits, delegation, or human control. State how the
> design applies it and why it matters.

Use DDIA, Fundamentals of Data Engineering, and AI Agents in Action lenses only
when they genuinely clarify the design. Place them beside the decision they
explain; do not collect them into an isolated glossary.

## Contracts and Data Flow

Define the conceptual input and output contracts in TypeScript-like pseudocode.

For each contract, specify ownership, allowed fields, prohibited data,
provenance and freshness fields, incomplete or unavailable states, and whether
it is persisted. Explain the end-to-end data flow in numbered steps.

## Workflow Behavior

If there are multiple paths, give each its own subsection and ASCII flow.

For every path, define entry criteria, deterministic readiness gates, valid
outcomes, wait/stop/failure behavior, whether AI or agents are allowed, and
whether human approval is required.

## Module Responsibilities

Use a table when modules or stages exist:

| Stage / component | Responsibility | Deterministic or agent-assisted | Inputs | Outputs |
| --- | --- | --- | --- | --- |

Keep measurement, validation, routing, and permissions deterministic. Constrain
agent-assisted modules to interpretation and structured proposals.

## Persistence, Tracing, and Idempotence

Describe what is persisted; what remains a source system of record; artifact
references and provenance; retry/backfill/idempotence behavior; trace/event
boundaries; and how credentials and raw provider data are excluded.

Add a DDIA learning note if data lineage, derived data, immutable history,
batching, or idempotence is relevant.

## Failure Handling and Safety

| Condition | Deterministic behavior |
| --- | --- |
| Missing or malformed input | ... |
| Partial or stale source data | ... |
| Agent schema failure | ... |
| Provider/API failure | ... |
| Human rejection | ... |
| Result evidence is insufficient | ... |

Never claim a metric that the underlying source cannot actually prove.

## Testing Strategy

List concrete test categories and essential cases:

1. Contract validation and privacy tests.
2. Deterministic gate tests.
3. Adapter/integration tests using fakes and fixed clocks.
4. Workflow route and wait-state tests.
5. Approval/no-write tests.
6. End-to-end fake evidence-to-artifact tests.

## Decisions and Deferred Work

For each major decision, state the decision, rationale, tradeoff, and what is
deliberately deferred.

## Done Means

Give numbered, observable acceptance criteria.

## Final self-review

Before saving:

1. Scan for TODO, TBD, placeholders, and contradictions.
2. Confirm all proposed capabilities map to a section and acceptance criterion.
3. Confirm the ASCII diagram matches the written boundaries.
4. Confirm no implementation work, secrets, or raw private data appear.
5. Confirm the spec distinguishes present code from proposed changes.

Then save the specification and report the exact file path, a 3–5 bullet
summary, the key boundary or seam the spec defines, and that implementation
planning is intentionally deferred until review.
````

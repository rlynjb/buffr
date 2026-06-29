# SECTION D — Agent infrastructure

Anchor: single-agent + multi-agent (both). The cross-cutting disciplines
that matter more than any single topology — and the section where buffr
exercises the most.

## Reading order

1. `01-context-engineering.md` — buffr's deliberate context assembly
   (profile + chunks + truncation + window guard) and the deliberate
   omission of in-prompt history. **Exercised.**
2. `02-agent-memory-tiers.md` — the most nuanced file: relevance recall
   yes, conversational threading no. **Exercised** (`@aptkit/memory`).
3. `03-tool-calling-and-mcp.md` — tool-calling is *emulated* for Gemma;
   no MCP (one in-process tool). **Exercised.**
4. `04-agent-evaluation.md` — retrieval scored (precision@k), trajectory
   captured but not yet scored. **Partial.**
5. `05-guardrails-and-control.md` — buffr's real control envelope (caps,
   window guard, read-only tool); input/human-gate absent by design.
   **Exercised.**

This section is where buffr is strongest — most files are "Exercised,"
not "Not yet implemented."

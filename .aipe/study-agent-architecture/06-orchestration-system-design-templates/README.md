# SECTION F — Orchestration system design templates

Anchor: codebases reframed as interview templates. Generated for every
guide regardless of shape. Same nine-bullet shape as
`study-ai-engineering`'s template sub-section — NOT the per-concept
template.

These reframe buffr as the answer to "design an agentic X system." The
architecture / data / scale / eval / failure bullets are generic; the
**Applies to this codebase** and **How to make it apply** bullets are
answered about buffr only.

## The three templates

1. `01-multi-agent-research-assistant.md` — **partially applies.** buffr
   is one agentic-RAG *worker* of this template's N; the supervisor /
   parallel / synthesis half is the refactor.
2. `02-agentic-support-system.md` — **partially applies.** buffr is the
   read-only, no-action *subset* — all the control envelope, none of the
   acting surface.
3. `03-agentic-coding-system.md` — **does not apply.** Furthest from
   buffr's shape; two ingredients (retrieval, bounded loop) exist, but
   adopting it is a rebuild, not a refactor. The honest distance is the
   lesson.

Read these to practice defending buffr's code as the answer to an
agentic-system design prompt — and to name precisely what each adoption
would cost.

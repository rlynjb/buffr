# Prompt Engineering — buffr-laptop

> The prompt in this repo is **assembled across three owners** and you (buffr) own
> only the first hop. Read that sentence again before you touch anything — most of
> what looks like "buffr's prompt behavior" is decided in `@rlynjb/aptkit-core`,
> and the load-bearing piece (tool calling) is *emulated in text* because Gemma 2
> 9B has no native tool API.

This guide is **audit-style** (the two-pass shape from `me.md`):

- **Pass 1 — `audit.md`.** Walks all 13 prompt-engineering concepts from the spec
  against this repo's actual code, with `file:line` grounding or an honest
  *not yet exercised*. Start here.
- **Pass 2 — pattern files.** One file per load-bearing prompt pattern this repo
  actually exercises. Named after the pattern, not the lens.

Written in a working-AI-engineer voice (production scars, demo-vs-prod
discipline), calibrated to a reader who has shipped LLM apps (AdvntrCue, aipe)
but is new to prompt engineering as a formal discipline.

---

## Reading order

Operational discipline first, then the specific mechanisms.

| # | File | One line |
|---|------|----------|
| — | [`00-overview.md`](00-overview.md) | The three-owner assembly in one diagram. Read first. |
| — | [`audit.md`](audit.md) | All 13 concepts walked against this repo. The map. |
| 01 | [`01-three-owner-prompt-assembly.md`](01-three-owner-prompt-assembly.md) | Who concatenates what, in what order, before Ollama sees a string. |
| 02 | [`02-tool-call-emulation.md`](02-tool-call-emulation.md) | **The load-bearing one.** Stock Gemma has no tool API; tools are rendered as text and JSON is parsed back, with one retry gated on a `{`. |
| 03 | [`03-profile-injection-as-personalization.md`](03-profile-injection-as-personalization.md) | `me.md` prepended to the system prompt = personalization with no extra call. |
| 04 | [`04-grounding-and-citation-instruction.md`](04-grounding-and-citation-instruction.md) | "Cite the sources" works because the tool hands back pre-formatted `[docId]` citations the model copies. Citation is **unenforced**. |
| 05 | [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md) | The forced "now answer, no more tools" turn that stops the agent looping forever. |
| 06 | [`06-structured-output-reprompt.md`](06-structured-output-reprompt.md) | Generate → parse → validate → retry-once with a strict JSON-only suffix. Built in aptkit, **not on buffr's hot path yet.** |

Concepts the spec lists that this repo **does not yet exercise** (covered honestly
in `audit.md`, not given their own file): few-shot prompting, prompt
versioning/eval-of-prompts, chain-of-thought, self-critique, meta-prompting,
prompt-injection defense, forbidden-patterns/rotation, output-mode-mismatch as a
code-review discipline.

---

## Cross-links

- **`study-ai-engineering`** (sibling generator) — the RAG retrieval pipeline,
  embeddings, precision@k evals, and the production-serving seam. Prompt
  engineering is the *text* that rides that pipeline; AI-engineering is the
  pipeline. The grounding-and-citation concept (04) and the structured-output
  reprompt (06) hand off there.
- **`study-agent-architecture`** (sibling generator) — the `runAgentLoop`
  tool/synthesis/turn-budget machinery, agentic retrieval, and memory recall as
  context. The bounded-synthesis nudge (05) and tool-call emulation (02) are the
  *prompt surface* of patterns that file walks as *control flow*.
- **`study-security`** — trust boundaries and the runtime-side defenses that
  complement author-side prompt-injection defense (see `audit.md` §12).

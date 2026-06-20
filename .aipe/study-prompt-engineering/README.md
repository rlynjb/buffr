# Prompt engineering — buffr

How buffr's prompts get built. Not the 13-concept curriculum survey —
this is an **audit** of one real system: a TypeScript laptop RAG agent
that runs **Gemma 2 9B** through **Ollama**, with all the prompt
machinery living in the consumed library `@rlynjb/aptkit-core`.

I've shipped RAG search features before. The interesting thing about
buffr isn't that it does RAG — it's that it does RAG on a **stock open
model with no native tool-calling API**, on a laptop, and the prompts
have to carry weight that a frontier model's built-in machinery would
carry for free. Every concept below is grounded in `file:line` across
buffr and aptkit-core. Where buffr doesn't exercise a prompt-engineering
concept, the audit says **not yet exercised** plainly.

---

## Reading order

Two passes (per the audit-style shape in `me.md`).

**Pass 1 — the audit.** One file. Walk every prompt-engineering lens
against the real code. Start here.

- [`audit.md`](audit.md) — system-prompt design, grounding/citation,
  context injection, tool-use prompting, structured output, instruction
  following on a weak local model, token budgeting, few-shot, CoT,
  self-critique, meta-prompting, injection defense, forbidden patterns.
  Each lens: `file:line` or **not yet exercised**.

**Pass 2 — discovered patterns.** One file per load-bearing prompt
pattern buffr actually runs. Read after the audit.

- [`00-overview.md`](00-overview.md) — the whole prompt, assembled in
  one diagram. Where each piece comes from.
- [`01-profile-injection-as-personalization.md`](01-profile-injection-as-personalization.md)
  — the `me.md`-style profile prepended to the system prompt under a
  heading. Standing context, not retrieval.
- [`02-grounding-and-citation-instruction.md`](02-grounding-and-citation-instruction.md)
  — the BASE_SYSTEM "search first, ground every answer, cite sources,
  say so plainly if you don't know" contract.
- [`03-tool-call-emulation-prompt.md`](03-tool-call-emulation-prompt.md)
  — **the load-bearing one.** Gemma has no native tool API, so the
  provider renders tools into the system text and demands a JSON tool
  call. The retry nudge. The `{`-tell heuristic.
- [`04-structured-output-reprompt.md`](04-structured-output-reprompt.md)
  — generate → extract JSON → validate → retry once with a strict
  JSON-only suffix. Fence-stripping. The courteous-markdown bug.
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md)
  — the forced final turn: "You have NO more tool calls available. Now
  answer, cite sources. Do not say you need more queries."

---

## One-line concept index

| File | Pattern | Anchor |
|------|---------|--------|
| `00-overview.md` | The full assembled prompt | `rag-query-agent.js`, `ask-cmd.ts` |
| `01-profile-injection-as-personalization.md` | Profile prepended to system prompt | `profile-injector.js:15`, `profile.ts:4` |
| `02-grounding-and-citation-instruction.md` | BASE_SYSTEM grounding contract | `rag-query-agent.js:12` |
| `03-tool-call-emulation-prompt.md` | Tools rendered as text + JSON demand | `gemma-provider.js:82` |
| `04-structured-output-reprompt.md` | Validate + strict-suffix retry | `structured-generation.js:9` |
| `05-bounded-synthesis-nudge.md` | Forced "now answer, cite" final turn | `run-agent-loop.js:17` |

---

## Cross-links to neighbor guides

These guides overlap with prompt engineering where mechanisms meet.
Follow them when the boundary is the interesting part.

- **`study-agent-architecture/`** — the *runtime* side of these prompts.
  `05-emulated-tool-calling.md` is the same Gemma mechanism viewed as
  an agent capability; `06-profile-as-standing-context.md` is the
  injection viewed as memory; `03-agentic-retrieval.md` is the loop the
  synthesis nudge terminates. Prompt engineering here is *what text we
  send*; agent architecture is *the loop that sends it*.
- **`study-security/`** — `03-indirect-prompt-injection-surface.md` is
  the runtime-side of concept #12 (injection defense). The author-side
  prompt defenses (or lack of them) are audited here; the trust-boundary
  view is there.
- **`study-ai-engineering/`** (sibling generator) — the production-serving
  and eval discipline that wraps these prompts. When present, cross-link
  its grounding/eval sections; this guide stays on *prompt text*.

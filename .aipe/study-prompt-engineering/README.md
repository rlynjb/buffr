# Prompt Engineering — buffr-laptop

Index + reading order for the prompt-engineering study guide, anchored to `buffr-laptop`'s real prompt path.

The thing to hold in your head before you open anything: in this repo **the prompt is not written, it is assembled** — across three owners, at runtime, every turn. There is no `prompt.md` you can open. The system prompt (`BASE_SYSTEM`) is a constant in aptkit, the profile gets prepended in front of it, and the tool catalog gets appended behind it by the model provider. Most of this guide is teaching you to see that assembly.

---

## Reading order

Operational discipline first, then the specific techniques. If you read top to bottom you build the mental model before the tricks.

### Start here

- **[00-overview.md](00-overview.md)** — the whole prompt path in one diagram. Three owners, one assembled string. Read this first; everything else hangs off it.
- **[audit.md](audit.md)** — the lens audit. Walks all 13 prompt-engineering concepts against the actual code, names what the repo exercises with `file:line` grounding, and names what it does not (`not yet exercised`) honestly.

### Operational concepts (the discipline)

1. **[01-anatomy.md](01-anatomy.md)** — the four sections of a production prompt, and how buffr's three owners map onto them.
2. **[02-structured-outputs.md](02-structured-outputs.md)** — tool calling, schemas, the markdown-fence bug, and why buffr's tool calls are *emulated* on a model with no native tool API. The load-bearing file.
3. **[03-prompts-as-code.md](03-prompts-as-code.md)** — prompts as version-controlled source, the prompt+model-version pairing, and where buffr's prompt actually lives (spoiler: in `node_modules`).
4. **[04-token-budgeting.md](04-token-budgeting.md)** — counting tokens, the 80% rule, lost-in-the-middle, prefix caching, and buffr's hard 8192-token guard.
5. **[05-eval-driven-iteration.md](05-eval-driven-iteration.md)** — the golden set, the regression suite, and the honest gap: buffr evals *retrieval*, not the *prompt*.

### Technique concepts (reach for these when the job calls for it)

6. **[06-single-purpose-chains.md](06-single-purpose-chains.md)** — one chain, one job; how buffr's single RAG agent compares to a multi-chain pipeline.
7. **[07-output-mode-mismatch.md](07-output-mode-mismatch.md)** — every chain declares one output mode; the JSON-vs-prose parser break.
8. **[08-few-shot.md](08-few-shot.md)** — examples constrain harder than instructions. `not yet exercised` in buffr — primary buildable target.
9. **[09-chain-of-thought.md](09-chain-of-thought.md)** — step-by-step reasoning, when it helps, when it wastes tokens. `not yet exercised`.
10. **[10-self-critique.md](10-self-critique.md)** — self-critique and self-consistency; the 2–5x cost; the blind-spot problem. `not yet exercised`.
11. **[11-meta-prompting.md](11-meta-prompting.md)** — using an LLM to write prompts; aipe's slash commands as the canonical example.
12. **[12-prompt-injection-defense.md](12-prompt-injection-defense.md)** — instruction hierarchy, delimiters, output-structure-as-defense; what buffr does and does not defend.
13. **[13-forbidden-patterns.md](13-forbidden-patterns.md)** — LLMs converge on phrasings; forbidden openings and rotating formulas. `not yet exercised`.

---

## What this repo exercises vs what it doesn't

A reader scanning this should learn what's interesting about buffr's prompt path before opening a single concept file.

```
  buffr-laptop — prompt-engineering coverage at a glance

  EXERCISED (load-bearing in the real path)
  ─────────────────────────────────────────
  ✓ three-owner prompt assembly        → 00, 01
  ✓ tool-call emulation prompt         → 02   ← the load-bearing one
  ✓ profile injection (personalization)→ 01, 12
  ✓ grounding & citation instruction   → 02, 05
  ✓ bounded synthesis nudge            → 02, 06
  ✓ structured-output reprompt         → 02   (aptkit has it; buffr's path doesn't fire it)
  ✓ token-budget guard (hard 8192)     → 04
  ✓ retrieval eval set                 → 05

  NOT YET EXERCISED (curriculum targets)
  ──────────────────────────────────────
  ✗ few-shot examples                  → 08
  ✗ prompt versioning / eval-of-prompts→ 03, 05
  ✗ chain-of-thought                   → 09
  ✗ self-critique / self-consistency   → 10
  ✗ prompt caching                     → 04
  ✗ forbidden-pattern rotation         → 13
```

---

## Cross-links to neighboring guides

- **`study-ai-engineering`** — the production-serving section covers the runtime-side defenses (output validation, never letting LLM output trigger side effects) that complement the author-side injection defenses in [12-prompt-injection-defense.md](12-prompt-injection-defense.md). The agent loop and retrieval pipeline are walked there in depth.
- **`study-agent-architecture`** — the ReAct loop (`runAgentLoop`), the tool registry, agentic retrieval, and the synthesis turn live there. This guide treats the agent loop only as far as it shapes the *prompt*; the loop's control flow is that guide's subject.

The persona writing this guide is a working AI engineer — production scars, not distributed-systems pedigree. Every claim points at a file you can open.

# AptKit Packages — Design Spec

**Date:** 2026-06-19
**Status:** Design — approved to capture, implementation not started
**Canonical:** this is the source of truth. Mirror (aptkit-scoped, pointer only):
`aptkit/docs/personal-agent-packages.md` — edit here, not there.
**Parent:** refines `agent-layer-plan.md` (buffr root)
**Reader profile:** `aipe/specs/me.md`

---

## What this is

A plan for the **missing parts** — the "packages" — of a Hermes-shaped personal agent,
each specced to fit **aptkit's actual conventions** (verified against the repo, not
assumed). This is deliberately *not* the integrated system. The body — how the packages
assemble into a running agent across laptop + phone — is a separate decision, parked on
purpose (see [Deferred](#deferred--waits-on-the-body-decision)).

The goal: build the parts first, get them real and hand-tested in isolation, *then*
decide the body. This dodges the one-way doors (sync model, gateway, two-brain
topology) while the buildable, decision-independent pieces move now.

### The bigger picture (context, not scope)

The north star is an agent that **lives across your surfaces, owns a model of you, and
acts** — Hermes' *"not a chatbot; an agent that lives on your machine and gets smarter."*
You already have most of its packages scattered across repos:

| Hermes layer            | What already exists                                  |
| ----------------------- | ---------------------------------------------------- |
| persistent memory       | `aipe/specs/me.md` (hand-built model-of-you)         |
| skills framework        | `aipe/` (markdown specs = SKILL.md; slash commands)  |
| model integration       | `aptkit/packages/providers` (anthropic/openai/local/fallback) |
| execution + sub-agents  | Claude Code (terminal, Agent tool, workflows)        |
| RAG / data              | AdvntrCue shipped it (rebuilding fresh — see package B) |
| trajectory → fine-tune  | named as the ceiling in `agent-layer-plan.md`        |
| **multi-platform gateway** | **❌ nothing**                                     |
| **the spine / body**    | **❌ nothing — packages exist, no body**               |

This spec builds the *aptkit-resident* packages that are still missing or unbuilt. It does
**not** build the body.

### The body decision (deferred — you are thinking about this)

Working architecture reached in brainstorming, recorded so it isn't lost:

```
   LAPTOP                                      PHONE
   ┌─────────────────────────┐                ┌─────────────────────────┐
   │ agent loop (terminal)   │                │ agent loop (RN app)     │
   │ + LOCAL LLM             │                │ + ON-DEVICE LLM         │
   │   Ollama / Gemma2:9b    │                │   Gemini-Nano-class     │
   │   → FULL brain          │                │   → LIGHT brain         │
   └───────────┬─────────────┘                └───────────┬─────────────┘
               │   reasoning is LOCAL on whichever device you're on
               └──────────────────┬──────────────────────────┘
                                  ▼
                  ┌──────────────────────────────────┐
                  │  SUPABASE — shared plane (always on)│
                  │  • memory:  me.md + conversation log │
                  │  • RAG:     chunks + pgvector         │
                  │  • Edge Fn: embed + search            │
                  └──────────────────────────────────┘
```

Reasoning local per device; data + retrieval shared in Supabase. Two open truths to
settle before building the body:

1. **Asymmetric brains.** Laptop Gemma2:9b is already weak at tool-calling; a phone
   on-device model is weaker. The phone can *ask*; the laptop does the *acting*.
2. **Two brains, one memory = a sync/merge problem** — the buffr
   canonical-local-with-cloud-mirror pattern, again. Only bites once both brains are live.

Build order for the body, when chosen: **laptop brain first, phone brain second** — so the
sync problem is the second thing you solve, not the first.

---

## The packages

```
  reasoning          ┌─ @aptkit/provider-gemma ──── the local brain engine
  (brain engine)     │   Ollama → Gemma, implements ModelProvider
                     │   ⚠ THE risk: Gemma has no tool-calling — must emulate
  ───────────────────┤
  RAG pipeline       ├─ @aptkit/retrieval ───────── built from scratch, adaptable
  (the hand)         │   EmbeddingProvider + VectorStore contracts;
                     │   in-memory store NOW, pgvector deferred;
                     │   chunk→embed→store→search→rank + search_knowledge_base tool
                     │   ⚠ NOT ported from AdvntrCue (which welded in OpenAI)
  ───────────────────┤
  memory seam        ├─ @aptkit/context/profile-injector.ts
  (makes it YOURS)   │   load me.md → inject into system prompt
  ───────────────────┤
  the ruler          ├─ @aptkit/evals/precision-at-k.ts
  (the numbers)      │   the metric aptkit is missing
  ───────────────────┘
  capstone           └─ profile-aware RAG agent — wires the four above,
  (proves compose)       terminal-only, no Supabase/phone/sync yet
```

All aptkit packages follow the same shape (verified): `@aptkit/<name>`, `"type":
"module"`, `tsc` build, tests via `node --test dist/test/*.test.js` using `node:test` +
`node:assert/strict`, `tsconfig` extends `../../../tsconfig.base.json` and references
`../../runtime`.

---

### A — `@aptkit/provider-gemma` · the local brain engine

**Path:** `packages/providers/gemma/`
**Implements:** `ModelProvider` from `packages/runtime/src/model-provider.ts`:

```ts
type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};
```

`complete()` maps aptkit's `ModelMessage[]` / `ModelTool[]` to the Ollama `/api/chat`
wire format and maps the response back to `ModelContentBlock[]` (`text` and `tool_use`
blocks) + `usage`. Wrap the instance in the `ContextWindowGuardedProvider` pattern from
`packages/providers/local/src/context-window-guard.ts` (Gemma2:9b ≈ 8k window). Register
by explicit instantiation (there is no global registry); composes under
`@aptkit/provider-fallback` for an API fallback chain.

Because the model sits behind the `ModelProvider` contract, it is **swappable, not
pinned**. "Self-hosted" means your data, memory, and skills are yours — *not* that one
model is welded in. A `provider-fallback` chain can put an API model (Claude) behind local
Gemma, so reliable *acting* is available when Gemma's tool-calling falls short, without
giving up the local-first default.

**⚠ The hard part — the whole reason this package is risky.**
The runtime expects the provider to surface `tool_use` blocks so `run-agent-loop` can
dispatch tools. **Gemma2:9b emits none** — Ollama has no tool template for it. So the
provider must:

1. **Outbound:** render available tools into the prompt/system text (Gemma can't take a
   native `tools` array meaningfully).
2. **Inbound:** prompt Gemma to print any tool call as JSON, then **parse that text back
   into `ModelToolUseBlock`** using `parseAgentJson` from
   `packages/runtime/src/json-output.ts` (already strips ``` fences and
   scavenges the first balanced `{…}`/`[…]` out of messy output).

Outbound is trivial; **inbound text→`tool_use` is the engineering**, and it's where the
agent loop stalls if it's flaky. This is the riskiest piece in the project — `de-risk
first` from the parent plan points exactly here. Try Ollama-native tool support first in
case a model template lands; assume emulation is required for Gemma2.

These are **two different failure surfaces**, and they must not be conflated: structured
*output* (the final answer's JSON) is one thing; tool-call *decoding* (did the model ask
to call a tool, and with what args) is another, and harder. A flaky answer degrades one
response; a flaky tool-call decode stalls the whole loop. The hard part of this package is
the second surface.

**Separation of concerns:** the provider only returns raw text + parsed blocks. It does
**not** validate JSON schemas — `generateStructured` (runtime) owns retry-with-strict-suffix.

**Hand-test artifact:** `node --test` over a recorded Ollama response fixture — assert a
deliberately messy Gemma blob parses into a clean `tool_use` block, and that plain text
returns a single `text` block. No live Ollama needed for the unit test.

**Depends on:** `@aptkit/runtime` only. **Long pole — start now; independent of B, so the
two run in parallel.**

---

### B — `@aptkit/retrieval` · the RAG pipeline, built from scratch, adaptable

**Path:** `packages/retrieval/`

Rebuilt from the ground up — **nothing ported from AdvntrCue**. AdvntrCue welded OpenAI
into the embedding path (vendor lock-in) and its architecture isn't a reliable base to
inherit. The design driver here is **adaptability**: the embedding vendor *and* the vector
store are swappable adapters behind contracts, the same way `ModelProvider` already has
local/openai/anthropic side by side. This is the me.md *"pattern over vendor"* value made
structural — *embedding + ANN + retrieval* is the pattern; nomic / OpenAI / pgvector /
in-memory are incidental.

**Two contracts — the adaptability seam:**

```ts
type EmbeddingProvider = {
  id: string;
  dimension: number;                  // 768 = nomic, 1536 = OpenAI, 1024 = Voyage
  embed(texts: string[]): Promise<number[][]>;
};

type VectorStore = {
  dimension: number;
  upsert(chunks: { id: string; vector: number[]; meta: Record<string, unknown> }[]): Promise<void>;
  search(vector: number[], k: number): Promise<{ id: string; score: number; meta: Record<string, unknown> }[]>;
};
```

**Concrete adapters:**
- `EmbeddingProvider` → `OllamaEmbeddingProvider` (`nomic-embed-text`, 768-dim, local),
  built now. OpenAI / Voyage are later drop-ins, no pipeline change.
- `VectorStore` → `InMemoryVectorStore` (cosine over an array), **built and fully tested
  now**. `PgVectorStore` is a second adapter, deferred to the body decision.

**Two paths, both library logic over the contracts:**
- indexing: `doc → chunk → embed → store.upsert`
- query: `query → embed → store.search → rank → chunks`
  The `search_knowledge_base` tool (the `ToolDefinition` / `ToolHandler` contracts from
  `packages/tools/src/tool-registry.ts`) wraps the **query path** and is registered into
  agents via `filterToolsForPolicy`.

**The honest constraint — embedding dimension is a one-way door for *data*, not code.**
Adapters make the *code* swappable any time; but a corpus embedded at nomic's 768 can't be
searched by a 1536-dim OpenAI query. Swapping the embedder *after* indexing means
**re-embedding the whole corpus**. So: the store carries its `dimension`, a provider/store
dimension mismatch throws loudly, and **re-index is a first-class operation** (the parent
plan already flags batch reindex past ~10k chunks). Adaptable interfaces, dimension-locked
data — named, not hidden.

**Build without Supabase, end to end.** Index a few markdown files into
`InMemoryVectorStore`, query, rank, return chunks — the whole RAG pipeline, hand-tested,
zero cloud. pgvector becomes the production `VectorStore` adapter once the body is decided.

**Hand-test artifacts:** (1) embed → upsert → search round-trip over the in-memory store
returns the planted relevant chunk on top; (2) a provider/store dimension mismatch throws;
(3) `search_knowledge_base`, through `InMemoryToolRegistry`, returns ranked results with a
`durationMs`.

**Depends on:** `@aptkit/runtime`, `@aptkit/tools`. Independent of A — parallel. **Now a
real package, not an afternoon — a co-lead with A**, since it owns the whole from-scratch
pipeline, not just a tool.

---

### C — `@aptkit/context/profile-injector.ts` · the memory seam

**Path:** new file in `packages/context/` (today the package only does workspace schema
summaries via `schemaSummary` — no profile primitive exists).

**Interface — keep it pure:**

```ts
function injectProfile(systemTemplate: string, profileText: string, opts?: { position?: 'start' | 'end'; heading?: string }): string;
```

Prepends (default) the `me.md` text into the system prompt *before*
`renderPromptTemplate` (from `@aptkit/prompts`) runs. **Correction to the earlier sketch:**
the function takes the profile *string*, not a file path — the caller reads the file. Pure
function, no `fs` inside the package: easier to test, matches aptkit's pure-function
style, and ESM-safe (no `require`).

This is the package that turns "a RAG box" into "*your* assistant" — it's where `me.md`
becomes live system context instead of a doc only `aipe` reads.

**Hand-test artifact:** unit test — given a template with `{schema}` and a fake `me.md`,
assert the profile text lands in the assembled system string at the right position and
template rendering still works.

**Depends on:** nothing (string in, string out). Independent — parallel.

---

### D — `@aptkit/evals/precision-at-k.ts` · the ruler

**Path:** new file in `packages/evals/`.
**Confirmed missing:** grep for `precision|recall|retrieval|ndcg|mrr` over
`packages/evals/src` returns nothing. The parent plan's *"run AptKit's eval-harness:
precision@5"* is aspirational — **no eval-harness exists** (only `rubric-judge`,
`detection-scorer`, structural assertions, and a replay-*artifact* validator). The
`detection-scorer` matches categorical field values, not ranked relevance — not reusable
for precision@k.

**Interface** (match the `DetectionScoreResult` shape for consistency):

```ts
function scorePrecisionAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): { ok: boolean; score: number; matched: number; total: number };
```

Pure function. Smallest package, highest portfolio leverage — it's the "numbers" the
parent plan's thesis sells. Add a sibling `scoreRecallAtK` for free.

**Faithfulness comes free** from the existing `RubricJudge`
(`packages/evals/src/rubric-judge.ts`) — define a rubric with grounding /
no-hallucination dimensions and **inject Claude as the judge model**, not Gemma. Don't
let Gemma grade Gemma; that number would be circular.

**Hand-test artifact:** unit test — known ranking + known relevant set → known
precision@k value; edge cases (k > list length, no relevant docs).

**Depends on:** nothing. Independent — parallel.

---

### E — capstone: profile-aware RAG agent · proves the packages compose

**Path:** mirror `packages/agents/query/` (new agent package, e.g.
`packages/agents/rag-query/`).

Wires the four packages through `runAgentLoop`:

- **A** Gemma provider (guarded) as `model`
- **B** retrieval tool registered, surfaced via `filterToolsForPolicy`
- **C** `me.md` injected into the system prompt before `renderPromptTemplate`
- **D** used in its eval to measure retrieval quality + faithfulness

Runs in the **terminal, one shot, against the real in-memory RAG pipeline** (package B with
`InMemoryVectorStore` — no mock needed). No Supabase, no phone, no sync, no gateway. This
is the smallest *living* thing — and it is exactly the deferred body's **v1a (laptop
brain)**, reachable later by swapping in `PgVectorStore`, no rework.

**Hand-test artifact:** index a handful of your real markdown into the in-memory store; ask
a question; observe it emit a `tool_use` for `search_knowledge_base`, retrieve real ranked
chunks, and answer grounded + in your voice (profile visibly shaping tone). An eval run
reports precision@k and a faithfulness score.

**Depends on:** A, B, C (and D for its eval). Build last.

---

## Build order

```
  A  provider-gemma   ████████████  long pole — riskiest (tool-call emulation)
  B  retrieval (RAG)  ██████████    co-long-pole — from-scratch adaptable pipeline
  C  profile-injector ██            ┐ easy, parallel
  D  precision-at-k   ██            ┘ (D is how you measure B)
                          ↓ once A + B done, C present
  E  capstone agent       ████      wires A+B+C, measured by D
```

Two long poles now: **A** de-risks tool-call emulation (everything downstream assumes it);
**B** is the from-scratch adaptable RAG pipeline you want to build. They're independent —
run in parallel. C and D are afternoon-sized; D is also the ruler you measure B with. E is
the payoff and yields a living laptop-only brain with every body decision still open.

Each package is built test-first (`node:test`) and ends in a hand-testable artifact, per
the parent plan's "each phase ends in a hand-testable artifact" discipline.

---

## Deferred — waits on the body decision

Not in this spec; depends on the architecture you're thinking through:

- The **`PgVectorStore` adapter** — the production `VectorStore` binding (package B's interface
  stays; only this adapter waits). pgvector + HNSW index, dimension fixed at index time.
- Supabase `agents` schema (documents / chunks / conversations / messages / tool_runs), RLS
- Edge Functions (embed + vector search + the always-on data plane)
- The phone RN brain (on-device model) and its agent loop
- Memory **sync/merge** between laptop and phone (the buffr local-first pattern)
- The multi-platform **gateway** (terminal + Telegram, "start on one, continue on another")
- Trajectory capture → fine-tune (the ceiling)

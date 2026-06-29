# Provider Abstraction

*Industry name: provider abstraction / ports & adapters (hexagonal) / dependency inversion. Type: **Industry standard.***

## Zoom out, then zoom in

Buffr depends on *interfaces* — "a model that can complete," "a store that can search" — and injects Ollama-backed implementations at one place. Swapping a provider is a constructor change. Here's the seam, with the injection site marked ★.

```
buffr stack — ports (interfaces) vs adapters (impls)
┌───────────────────────────────────────────────────────────┐
│ RagQueryAgent   depends on ModelProvider (PORT)             │
├───────────────────────────────────────────────────────────┤
│ retrieval pipeline   depends on VectorStore + Embedder      │ (PORTS)
├───────────────────────────────────────────────────────────┤
│ ★ src/session.ts   constructs the ADAPTERS, injects them    │ THE WIRING POINT
├───────────────────────────────────────────────────────────┤
│ GemmaModelProvider · OllamaEmbeddingProvider · PgVectorStore│ ADAPTERS (Ollama/pg)
└───────────────────────────────────────────────────────────┘
   ★★ and one thing you CANNOT swap freely: the 768 dimension
```

Above `session.ts`, nothing names Ollama or Postgres — the agent and pipeline only know the *shapes* (`ModelProvider`, `VectorStore`). `session.ts` is the one file that picks concrete implementations and injects them. That's the port/adapter pattern. This file covers it, and then the one exception that *isn't* freely swappable: the **768 one-way door**, asserted at four sites.

## Structure pass — trace *what knows the vendor* across the stack

Pick one axis: **which layers know they're talking to Ollama/Postgres?** Trace it and find where vendor knowledge is allowed.

```
vendor knowledge, top → bottom
  RagQueryAgent       │ knows: "a ModelProvider"      │ vendor-blind
  retrieval pipeline  │ knows: "a VectorStore"        │ vendor-blind
  ─────────────────────────────────────────────────  THE SEAM
  src/session.ts      │ knows: Ollama host, pg pool   │ vendor-AWARE  ★
  GemmaModelProvider  │ knows: Ollama /api/chat       │ vendor-aware
  PgVectorStore       │ knows: pgvector SQL           │ vendor-aware
```

The seam is `session.ts`. Everything above it is written against ports and could run on OpenAI + Pinecone unchanged. Everything at and below is vendor-aware by design. The discipline: vendor knowledge is *quarantined* to the wiring file and the adapters. The payoff is concrete — to move generation from local Gemma to a hosted model, you edit one constructor in one file, and the agent never notices.

## How it works

### Move 1 — the mental model: props vs hard imports

You know this from React: a component that takes a `<Button onClick>` prop works with any button; a component that hard-imports `./MyButton` is welded to it. Ports & adapters is "everything takes props." The agent takes a `model` prop (any `ModelProvider`); `session.ts` is the parent that decides which concrete one to pass.

```
the dependency direction
  RagQueryAgent ──depends on──▶ ModelProvider (interface)
                                      ▲ implements
  GemmaModelProvider ───────────────┘
  ───────────────────────────────────────────────────────
  the agent points at the INTERFACE, never at Gemma directly
```

### Move 2 — the moving parts

#### The wiring point: one place builds every adapter

`createChatSession()` (`src/session.ts:39–57`) is the composition root — it constructs the Ollama embedder, the pg store, the Gemma model (guarded), and injects them into the pipeline and agent:

```ts
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store    = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });                  // ← ports get adapters
const model    = new ContextWindowGuardedProvider(new GemmaModelProvider({ host: cfg.ollamaHost }),
                                                  { maxTokens: 8192 });          // ← decorator over an adapter
const agent    = new RagQueryAgent({ model, tools, profile, trace });           // ← agent gets a PORT-typed model
```

Annotation that matters: `RagQueryAgent` receives `model` typed as `ModelProvider`. To swap to a hosted provider, you change *only* the `new GemmaModelProvider(...)` line to `new OpenAiModelProvider(...)` — the agent, the loop, the trace sink all stay byte-identical. That's the entire value of the abstraction: change is local.

```
the swap, visualized
  RagQueryAgent({ model, ... })          ← unchanged
        ▲
        │ inject
  ┌─────┴───────────────────────────┐
  TODAY:  GemmaModelProvider          │  change ONE line in session.ts
  SWAP:   OpenAiModelProvider         │  everything above is untouched
  └─────────────────────────────────┘
```

#### The decorator stack: guard wraps adapter, both are `ModelProvider`

`ContextWindowGuardedProvider` *also* implements `ModelProvider` and wraps another one (`context-window-guard.ts:38–47`). So the guard is itself a port-compatible adapter — it can wrap Gemma, OpenAI, anything. That's why the token guard from file 02 composes cleanly: it speaks the same interface it consumes.

```
decorator = port wrapping a port
  ContextWindowGuardedProvider (ModelProvider)
        │ wraps
        ▼
  GemmaModelProvider (ModelProvider)
  both satisfy the same port → the agent can't tell them apart
```

### Move 2.5 — the 768 one-way door (the exception to "swap freely")

Most of the abstraction lets you swap freely. **The embedding dimension does not.** `nomic-embed-text:v1.5` produces 768-dim vectors, and that number is welded into four places. Swap the embedder for a model with a different dimension and you must change *all four* and re-index every vector — there's no migration, it's a one-way door.

```
the 768 one-way door — four assertion sites
  1. provider          OllamaEmbeddingProvider.dimension = 768   ← source of truth
  2. pipeline          assertWiring (aptkit) checks embedder vs store match
  3. PgVectorStore     assertDim(v): throw if v.length !== 768   (pg-vector-store.ts:32-36)
  4. SQL               embedding vector(768)  (sql/001_agents_schema.sql)
  ─────────────────────────────────────────────────────────────────────────
  change the embedder's dim → all four must change → re-embed EVERY chunk
```

Here's the per-vector assertion that fails loudly if a wrong-sized vector ever reaches the store (`src/pg-vector-store.ts:32–36`):

```ts
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
```

Annotation that matters: the dimension flows from the embedder (`store = new PgVectorStore({ ..., dimension: embedder.dimension })`), so the *provider* is the single source of truth — but the SQL `vector(768)` column type is a *hard* constraint the database enforces independently. The abstraction is clean for *which* model; it is rigid for *what shape* that model emits.

### Move 3 — the principle that generalizes

> **Depend on the port, not the adapter — so the vendor lives in one file and swaps are local. But know the seams that *don't* abstract: a vector dimension is a one-way door, enforced top to bottom, and pretending otherwise gets you a re-index outage.**

The port/adapter pattern buys you cheap swaps for *behavior* (which model, which store). It does **not** buy you free swaps for *data shape* (the 768 dimension). Buffr is honest about this: it asserts the dimension at four levels so a mismatch fails immediately and loudly, instead of silently corrupting the index. Good abstraction isn't "everything is swappable" — it's "swappable things are swappable, and the rigid things scream when you try."

## Primary diagram

Ports above the seam, adapters below, and the four-site one-way door cutting across.

```
provider abstraction in buffr
  ┌──────────── PORTS (vendor-blind) ────────────┐
  │ RagQueryAgent → ModelProvider                 │
  │ pipeline → VectorStore, Embedder              │
  └───────────────────┬───────────────────────────┘
                      │ inject (src/session.ts — the ONE wiring file)
  ┌───────────────────┴──── ADAPTERS (Ollama/pg) ──────────────────┐
  │ GemmaModelProvider · OllamaEmbeddingProvider · PgVectorStore     │
  └─────────────────────────────────────────────────────────────────┘
  swap a provider = change ONE constructor in session.ts ✓

  ╔═══════════ the 768 ONE-WAY DOOR (cuts across all layers) ═══════════╗
  ║ provider.dimension → assertWiring → assertDim → SQL vector(768)      ║
  ║ change it → re-embed every chunk. No migration. ✗ not a free swap.   ║
  ╚═════════════════════════════════════════════════════════════════════╝
```

## Elaborate

- **Origin.** Dependency inversion (the "D" in SOLID) and Cockburn's hexagonal/ports-and-adapters architecture. The LLM-era version is the "provider" or "LLM gateway" — a uniform interface over OpenAI/Anthropic/Ollama so app code is vendor-neutral. aptkit's `ModelProvider`/`VectorStore` are exactly these ports.
- **Adjacent concepts.** *What an LLM is* (01) — `complete()` is the model port. *Token economics* (06) — swapping to a hosted provider is what makes dollars real, and it's a one-constructor change *because* of this abstraction. *Embeddings* (sub-section 03) — where the 768 dimension is actually consumed.
- **Honest gap.** The behavioral abstraction is genuinely clean (one wiring file). The 768 dimension is the un-abstractable seam, and buffr handles it the right way: assert at four levels rather than pretend it's swappable. There's no migration path if you change it — that's a real, accepted limitation.
- **What to read next.** File 09 — user-override locks, another "data shape" concern where the abstraction stops and persistence discipline begins.

## Project exercises

### Add a second model provider behind the same port

- **Exercise ID:** [B1.15] (Phase 1 — LLM foundations) — the abstraction is **implemented**; this proves it.
- **What to build:** Wire an alternate `ModelProvider` (e.g. a different Ollama model, or a hosted-API adapter) selectable by an env var in `src/config.ts`, switching the constructor in `session.ts` without touching `RagQueryAgent`. Proves "swap = one constructor."
- **Why it earns its place:** The abstraction is only real if you've exercised the swap. This makes the port concrete and surfaces any hidden vendor leakage.
- **Files to touch:** `src/config.ts` (a `MODEL_PROVIDER` env var); `src/session.ts:46` (branch on it); a new adapter if hosted. The agent stays untouched — that's the test.
- **Done when:** flipping the env var changes the generation backend with zero edits to `RagQueryAgent` or the trace sink.
- **Estimated effort:** 1–4hr

### Make the 768 door fail at startup, not mid-index

- **Exercise ID:** [B1.16] (Phase 1 — LLM foundations) — the four asserts exist; this hardens them.
- **What to build:** A startup check in `createChatSession` that compares `embedder.dimension` against the SQL column's declared dimension (query `information_schema` / pgvector typmod) and throws *before* any indexing if they disagree — moving the failure from the per-vector `assertDim` to boot time.
- **Why it earns its place:** Today a dimension mismatch fails on the first vector write; catching it at startup turns a confusing mid-run error into a clear boot-time refusal, reinforcing that the dimension is a one-way door.
- **Files to touch:** `src/session.ts` (boot check); read-only against `src/pg-vector-store.ts` and `sql/001_agents_schema.sql`.
- **Done when:** booting with a mismatched embedder/SQL dimension throws a clear error at session creation, before any chunk is embedded.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: "How hard is it to swap buffr's model or vector store, and where does that break down?"**

Model answer: For the model, trivial — `RagQueryAgent` depends on the `ModelProvider` port, so swapping Gemma for a hosted adapter is one constructor change in `session.ts`; the agent, loop, and trace sink are untouched. Same for the store behind the `VectorStore` port. Where it breaks down is the embedding *dimension*: `nomic-embed-text:v1.5` emits 768, and that's welded into four places — the provider, `assertWiring`, `PgVectorStore.assertDim`, and the SQL `vector(768)` column. Swapping to a model with a different dimension means re-embedding every chunk; there's no migration. So the abstraction is clean for *which* model, rigid for *what shape* it emits — and buffr asserts that shape at four levels so a mismatch fails loudly instead of corrupting the index.

```
swap difficulty
  model / store  │ one constructor in session.ts   │ EASY (port)
  768 dimension  │ provider+wiring+assertDim+SQL    │ ONE-WAY DOOR (re-index)
  ★ asserted 4× so a mismatch screams, not corrupts
```

Anchor: *Depend on the port — model swaps are local; the 768 dimension is the one-way door.*

## See also

- `01-what-an-llm-is.md` — `complete()` is the model port this file abstracts.
- `06-token-economics.md` — the hosted-provider swap that makes dollars real.
- `../03-retrieval-and-rag/` — where the 768-dim vectors are produced and consumed.

# Study — System Design (buffr-laptop)

A per-codebase system-design guide for `buffr-laptop`: the architecture
actually present in the repo — boundaries, flows, state ownership, storage
choice, failure handling, and the deliberately-deferred scale story. Built
audit-style (two passes): one audit walking eight lenses, then one file per
load-bearing pattern the repo really exercises.

## What this repo is, in one line

The **body** of a self-hosted RAG agent: TS ESM, three CLIs (`index` / `ask`
/ `eval`) over Postgres + pgvector, consuming `@rlynjb/aptkit-core` (the
toolkit) for the agent loop, providers, retrieval pipeline, and evals.
Single device, single user, no HTTP API — and precise about what it defers.

## Reading order

1. **`00-overview.md`** — one full-system diagram + legend. Skim this and you
   have the whole map.
2. **`audit.md`** — Pass 1. The 8-lens system-design audit, every claim
   grounded in `file:line`, with honest `not yet exercised` where the repo
   does nothing.
3. **`01-vector-store-adapter.md`** — `PgVectorStore implements VectorStore`;
   the seam that drops Postgres into aptkit. The most load-bearing buffr code.
4. **`02-retrieval-pipeline.md`** — index and query end to end; the RAG
   retrieve half and the eval that measures it.
5. **`03-trajectory-capture.md`** — the trace sink; sync `emit()` /
   async `flush()` bridging aptkit's contract to async pg writes.
6. **`04-library-as-dependency-boundary.md`** — aptkit consumed, never edited;
   the repo-split that defines the whole architecture.
7. **`05-cli-as-entrypoints.md`** — three run-on-import processes, one shared
   wiring, ordered teardown.
8. **`06-profile-injection-as-context.md`** — me.md as a DB row, injected into
   the system prompt.
9. **`07-deferred-body.md`** — single-device now, two-brain / edge / RLS
   later; YAGNI behavior, forward-compat seams. The architectural thesis.

## The pattern files at a glance

| File | What the system would lose without it |
| --- | --- |
| `01-vector-store-adapter` | persistence that drops into the agent unchanged |
| `02-retrieval-pipeline` | grounding + citations (it'd be a chatbot, not RAG) |
| `03-trajectory-capture` | conversation history + the fine-tune dataset seam |
| `04-library-as-dependency-boundary` | aptkit's reuse across apps |
| `05-cli-as-entrypoints` | any way to drive the system |
| `06-profile-injection-as-context` | the agent's persona (generic voice) |
| `07-deferred-body` | free future phases (no-rework scale path) |

## Cross-links to neighboring foundation guides

System design owns architectural boundaries and tradeoffs. Mechanism-level
teaching belongs to the owning foundation generator:

- **`study-database-systems`** — how pgvector executes `<=>` cosine distance,
  HNSW index internals (recall vs `ef`), transaction semantics of the upsert
  `begin/commit`.
- **`study-data-modeling`** — the `agents` schema shape: `documents`/`chunks`
  split, the deliberately-dropped FK, `app_id` denormalization,
  `vector(768)` as a typed column, forward-compat columns.
- **`study-distributed-systems`** — the coordination mechanics the *deferred*
  phases introduce: RLS-as-isolation, edge-function boundary, laptop↔phone
  sync correctness.
- **`study-runtime-systems`** — the per-invocation process lifecycle, the
  connection-pool teardown, the floating-promise queue-and-join in the trace
  sink.

And the AI/design neighbors this guide touches:

- **`study-ai-engineering`** / **`study-agent-architecture`** — the RAG
  pattern, the agent loop inside `RagQueryAgent`, eval scoring (P@1 / R@k).
- **`study-prompt-engineering`** — how the injected profile + retrieved
  context are assembled into the prompt.
- **`study-software-design`** — the deep-module / info-hiding read of the
  adapter seams and the pure `loadConfig`.

## A note on honesty

This repo is `v1b` of a deferred body. Several system-design lenses correctly
read `not yet exercised` — no caching, no retries/timeouts, no multi-region,
no gateway, no horizontal scale. That's not a gap to paper over; it's the
design. `audit.md` names each one plainly, and `07-deferred-body.md` shows why
deferring them is the correct call and which seam each deferred phase attaches
to when it arrives.

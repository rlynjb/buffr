# Study — Testing & Correctness · buffr-laptop

The through-line: **how do you know this code works — and will keep working
after the next change?** A good suite tells you what a change broke before
your user does. A suite that doesn't is decoration.

This guide audits the `node:test` suite in `test/` against the code in `src/`,
then names the testing *techniques* the repo exercises on purpose.

```
  The seam that organizes this whole guide

  ┌─ DETERMINISTIC correctness ─────────────────┐   ← this guide
  │  given known input, assert known output     │
  │  test/*.test.ts  ·  node:assert/strict       │
  │  "hits[0].id === 'planted#0'"                │
  └───────────────────────┬──────────────────────┘
                          │  hands off at the embedding boundary
  ┌─ PROBABILISTIC evaluation ──▼────────────────┐   ← study-ai-engineering
  │  is the answer good enough / did it regress? │
  │  precision@k · recall@k · faithfulness        │
  │  scorePrecisionAtK lives in aptkit-core       │
  │  src/cli/eval-cmd.ts is the REPORTING script  │
  └──────────────────────────────────────────────┘
```

The line that matters: if the assertion is **equals the expected value**, it's
a test and it lives here. If the assertion is **is this retrieval good enough**,
it's an eval and it lives in `study-ai-engineering`. They meet exactly once in
this repo — at the `EmbeddingProvider` seam, where `runtime.test.ts` swaps a
deterministic fake embedder in so the indexing path can be asserted with
`equals`, no Ollama, no probability.

## Reading order

1. **`audit.md`** — Pass 1. The 7-lens audit: what's tested, what isn't,
   where it's sound, where it's thin. Start here for the verdict.
2. The pattern files — Pass 2, the techniques this repo reaches for on purpose:

   - **`01-env-gated-integration-tests.md`** — five of six test files skip
     cleanly when `DATABASE_URL` is unset. The `skip` option on `describe` is
     the gate. This is the single most load-bearing testing decision in the repo.
   - **`02-fake-embedder-injection.md`** — `runtime.test.ts` injects a
     deterministic 768-dim fake `EmbeddingProvider` so the indexing path is
     asserted with `equals`, with no Ollama in the loop. The deterministic
     harness around a probabilistic core, made concrete.
   - **`03-contract-parity-vector-store.md`** — `PgVectorStore` is tested as a
     drop-in for aptkit's in-memory `VectorStore`; the missing FK on
     `chunks.document_id` exists *because of* this contract.
   - **`04-idempotent-migration-test.md`** — `migrate.test.ts` runs the schema
     twice and asserts no error. The test that pins `create ... if not exists`.
   - **`05-full-signal-trace-capture.md`** — `supabase-trace-sink.test.ts` grew
     a second `it` that emits one of every `CapabilityEvent` type and asserts
     the *whole* payload survives (tool args, `durationMs` + error, token sum,
     warning/error rows, `created_at` ordering). The test that pins "no signal
     dropped on the floor."

## The honest gaps (named in full in `audit.md`)

- **No CI.** The DB tests only run on a laptop with `DATABASE_URL` set and
  Postgres+pgvector reachable. On any other machine the suite is green by
  *skipping*, not by passing. A green run proves nothing unless you check it ran.
- **The chat session is not tested.** `src/cli/ask-cmd.ts` is gone; the repo's
  main path is now `createChatSession` (`src/session.ts`) behind an Ink TUI
  (`src/cli/chat.tsx`), run via `npm run chat` against live Gemma by hand. The
  deterministic per-turn `ask()` wrapper — user-turn persistence, trace flush,
  the swallowed memory-write failure — has no assertion. This is the new
  highest-leverage gap.
- **`config.test.ts` is the only pure unit test.** Everything else needs a
  database.

## Cross-links

- **software-design** — "this code is hard to test" is a design finding, not a
  testing one. The thing that makes this suite testable (`loadConfig(env)` taking
  env as an argument; the pool injected into every function) is deep-module /
  dependency-injection design. See `.aipe/study-software-design/`.
- **ai-engineering** — the eval half of the seam (precision@k, recall@k,
  faithfulness, the labeled `eval/queries.json` set) is audited there, not here.
- **debugging-observability** — `SupabaseTraceSink` persists the agent's
  trajectory to `agents.messages`; the trace it writes is both the
  observability surface and the thing `supabase-trace-sink.test.ts` asserts on
  — now the *full* event signal (see `05-full-signal-trace-capture.md`).

---

Updated: 2026-06-24 — purged `ask-cmd.ts` (deleted) → `session.ts`/`chat.tsx`
`npm run chat` named as the new highest-leverage gap; added the
`05-full-signal-trace-capture.md` pattern to the reading order.

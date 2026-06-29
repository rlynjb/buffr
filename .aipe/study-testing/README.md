# Study — Testing & Correctness (buffr-laptop)

> How do you *know* the code works — and will keep working after the next change?

This guide audits the test suite of `buffr-laptop` (the laptop "brain" of a self-hosted personal RAG agent: TypeScript ESM, `node:test` + `node:assert/strict`, Postgres + pgvector, an Ollama-served Gemma loop, and an Ink chat CLI). It is grounded in the real files — what's tested, how, and where the holes are.

The verdict up front: **the suite is small but honest — 9 tests, 9 pass, and every test that touches the database says so by gating on `DATABASE_URL` and skipping cleanly when it's unset.** The test *design* is unusually disciplined for a personal project: the database-touching tests are real integration tests against a live Postgres, the embedder is faked deterministically so the model never enters the loop, and the persistence layer (`PgVectorStore`) is tested as a contract that mirrors aptkit's in-memory store. The single highest-leverage gap is that the one piece of code that orchestrates everything — `src/session.ts` — has **no test at all**.

---

## The seam that organizes this guide: deterministic vs eval

There are two ways to check an AI system, and they are not the same job:

```
  The correctness seam — which half is a finding on?

  ┌─ DETERMINISTIC correctness ────────────┐   ┌─ EVALUATION ──────────────────┐
  │  given known input, assert known output│   │  is the OUTPUT good enough /   │
  │  assert.equal(score, 123)              │   │  did it regress?               │
  │                                        │   │  precision@k, recall@k,        │
  │  unit · integration · contract         │   │  LLM-as-judge                  │
  │                                        │   │                                │
  │  ← THIS GUIDE                          │   │  → study-ai-engineering        │
  └────────────────────────────────────────┘   └────────────────────────────────┘
         the assertion is "=="                    the assertion is "good enough"
```

If a test asserts an **exact value** — `tokens_used === 123`, `hits[0].id === 'planted#0'`, replay order `=== ['tool_call','tool','model_usage','warning','error']` — it's a *testing* finding and it lives here. If it asserts a **threshold on a non-deterministic output** — "mean P@1 over the eval set didn't drop below 0.6" — it's an *evaluation* finding and it belongs to `study-ai-engineering`.

This repo has both, and the line is clean: `test/` is all deterministic (`==`), and `eval/queries.json` + `src/cli/eval-cmd.ts` is the eval seam (a reporting script, not a unit test — it prints precision@k, it never asserts). They **meet** in exactly one place: the trace-sink test wraps a deterministic harness around what would otherwise be a probabilistic agent run, by capturing synthetic `CapabilityEvent`s instead of running Gemma. That's the textbook shape — a deterministic harness around a probabilistic core — and this repo gets it right. See `audit.md` → lens 6.

---

## Reading order

1. **`00-overview.md`** — the audit at a glance: coverage map, the three highest-leverage gaps, one-line verdict per lens.
2. **`audit.md`** — Pass 1. The 7-lens walk, each lens grounded in `file:line` or marked `not yet exercised` honestly. The capstone lens consolidates the red-flag checklist.
3. **Pass 2 — the discovered-pattern files.** Each names a testing *technique* this repo applies deliberately, walked with the full concept template:
   - **`01-env-gated-integration-tests.md`** — the `DATABASE_URL`-gated suite that SKIPs instead of failing.
   - **`02-fake-embedder-injection.md`** — the deterministic 768-dim test double that keeps Ollama out of the loop.
   - **`03-contract-parity-test.md`** — `PgVectorStore` tested as the same contract aptkit's in-memory store satisfies.
   - **`04-idempotent-migration-test.md`** — run the migration twice, assert no error.
   - **`05-full-signal-trajectory-assertion.md`** — assert all 6 `CapabilityEvent` types land, with `created_at` ordering.

---

## Cross-links to sibling guides

- **`study-ai-engineering`** — the *eval* half of the seam: `eval/queries.json`, precision@k / recall@k scoring, where probabilistic output gets judged. This guide stops at the `==` boundary; that one picks up at "good enough."
- **`study-software-design`** — "hard to test" is a *design* smell, not a testing finding. Where this guide notes a module is awkward to test (e.g. `chat.tsx`'s top-level `await createChatSession()` side effect), it cross-links there rather than re-auditing the design.
- **`study-debugging-observability`** — the trace sink (`src/supabase-trace-sink.ts`) is the same artifact viewed from two angles: here it's a thing under test; there it's the production observability mechanism. The full-signal trajectory is the overlap.

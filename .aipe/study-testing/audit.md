# Audit — Testing & Correctness · buffr-laptop (Pass 1)

Seven lenses, worst-first within each. Grounded in `file:line`. Where a lens
finds nothing, it says `not yet exercised` and names the buildable target.

The suite: six `test/*.test.ts` files, **9 tests, 9 passing**, `node:test` +
`node:assert/strict`, run via `node --test --test-concurrency=1
dist/test/*.test.js` after a `tsc` build (`package.json:8`). One file is a pure
unit test; five are DB integration tests gated on `DATABASE_URL`.

```
  The suite at a glance — what each file needs to run

  file                          level         needs DATABASE_URL?
  ─────────────────────────────────────────────────────────────────
  config.test.ts                pure unit     no  — always runs
  migrate.test.ts               integration   yes — skips if unset
  pg-vector-store.test.ts       integration   yes — skips if unset
  profile.test.ts               integration   yes — skips if unset
  runtime.test.ts               integration   yes — skips if unset
  supabase-trace-sink.test.ts   integration   yes — skips if unset
```

---

## 1. what-is-tested-and-what-isnt

The risk map, not a percentage. Walk it by criticality.

**The persistence seam is well covered.** Every `src/` module that touches
Postgres has a test that drives the real SQL:

- `PgVectorStore.upsert` / `.search` → `pg-vector-store.test.ts:30-46`
- `runMigration` → `migrate.test.ts:16-27`
- `indexDocumentRow` (documents row + chunk indexing) → `runtime.test.ts:31-40`
- `loadProfile` → `profile.test.ts:21-25`
- `SupabaseTraceSink.emit/flush` + `startConversation` →
  `supabase-trace-sink.test.ts:23-67` (two `it`s — see below)
- `loadConfig` → `config.test.ts:6-19`

That is one test file per `src/` *persistence* module that has logic worth
pinning. For a single-device persistence layer, the coverage map is shaped
correctly: the **most important persisted code — the SQL contract with pgvector
— is the most tested.** No inverted risk pyramid at the storage seam.

The one inversion that *does* exist now is above the storage seam: the most
recently-written, behavior-carrying module — `src/session.ts`, the chat
orchestrator — has **zero tests**, and it's the new highest-leverage gap (#1
below).

**What is not tested, ranked by how much it would hurt:**

1. **The chat session (`src/session.ts` + `src/cli/chat.tsx`).** `npm run ask`
   and `src/cli/ask-cmd.ts` are **gone** — deleted and replaced by an
   interactive Ink chat (`package.json:11` `"chat"`). `createChatSession`
   (`session.ts:34-76`) is now the assembly point the whole repo runs through:
   it builds the embedder, store, pipeline, tool registry, guarded model,
   profile, *and* episodic memory, opens one long-lived conversation, and
   returns `ask()` / `close()`. The per-turn `ask()` (`session.ts:60-71`)
   carries real deterministic logic — persist the user turn → run the agent →
   `trace.flush()` → best-effort `memory.remember()` — and **none of it is
   asserted**. The Ink UI (`chat.tsx`) that drives it is equally untested.
   This is the single highest-leverage gap in the suite. → see lens 6 for the
   seam (a fake `ModelProvider`) that makes `ask()` assertable.

2. **The eval reporting path (`src/cli/eval-cmd.ts`).** This is not a unit test
   and shouldn't be — it's a *reporting script* that prints mean P@1 / R@3 over
   `eval/queries.json` (`eval-cmd.ts:22-33`). The scoring functions
   `scorePrecisionAtK` / `scoreRecallAtK` live in `@rlynjb/aptkit-core`, not
   here, so they're tested upstream. This is the eval half of the seam and
   belongs to `study-ai-engineering`, not this guide. Correctly NOT a
   `node:test` case.

3. **`src/db.ts` `createPool`.** A two-line factory (`db.ts:4-6`). Too small to
   test meaningfully; it's exercised transitively by every integration test's
   `before` hook. Leave it.

4. **The migrate CLI block** (`migrate.ts:23-32`) — the `import.meta.url`
   entrypoint guard, the "DATABASE_URL is not set" throw, the
   `migration applied\n` stdout. Not asserted. Low risk, but the
   `DATABASE_URL is not set` throw is duplicated verbatim across the CLI
   entrypoints (`index-cmd.ts:12`, `eval-cmd.ts:11`, `session.ts:37`) and never
   tested on any of them.

---

## 2. test-design-and-levels

The pyramid as-built is **one pure unit test sitting on five integration
tests, no e2e**:

```
  Pyramid as-built — top-heavy on integration, no e2e

      (no e2e — chat session against live Gemma is manual via npm run chat)
        ╱                                              ╲
       ╱  integration ×5  (real Postgres + pgvector)    ╲
      ╱   migrate · pg-vector-store · profile ·           ╲
     ╱    runtime · supabase-trace-sink                     ╲
    ╱──────────────────────────────────────────────────────╲
   ╱  unit ×1   loadConfig(env)  — config.test.ts            ╲
  ╲──────────────────────────────────────────────────────────╱
```

This is **not** the textbook pyramid (wide unit base, thin integration, sliver
of e2e). And for this repo, that's the right call — say it plainly. The logic
in `src/` that's worth testing is almost entirely *SQL behavior*:
`embedding <=> $1::vector` cosine ordering, `on conflict (id) do update`
upserts, `create ... if not exists` idempotency. You cannot test cosine
ranking against a mock — a mock that returns `planted#0` first proves only that
you wrote the mock to do that. The integration-heavy shape is honest about
where the risk lives: at the database boundary.

**No over-mocking.** This is the suite's biggest strength. There is exactly one
test double in the entire repo — the fake embedder at `runtime.test.ts:14-17` —
and it's injected at a real seam (aptkit's `EmbeddingProvider` interface) to
remove a *non-deterministic, network-bound* dependency, not to avoid writing a
real test. Every other test drives real Postgres. Nothing here tests a mock and
calls it coverage. The flip side of that discipline: the new `session.ts`
orchestration has **no** test double standing in for `GemmaModelProvider`, so
its deterministic wrapper goes unasserted entirely (lens 6).

**The one real design weakness: redundant setup, no shared harness.** Each of
the five DB files independently opens a pool (`createPool(url!)`), reads the
schema file, and runs `runMigration` in its own `before` hook
(`pg-vector-store.test.ts:14-18`, `profile.test.ts:14-18`,
`runtime.test.ts:21-24`, `supabase-trace-sink.test.ts:14-17`). That's the same
~5 lines of boilerplate copy-pasted five times. It works, but a shared
`test/helpers/withDb.ts` (open pool, migrate once, hand back a cleanup) would
remove the duplication and the risk of the five copies drifting. Constructive
target: extract the `before`/`after` pool+migrate dance into one helper.

---

## 3. tests-as-design-pressure

This is where the suite quietly proves the *design* is good. The tests are easy
to write, and they're easy because of three deliberate design choices in `src/`:

- **`loadConfig(env)` takes env as an argument** (`config.ts:9`), not a global
  read of `process.env`. So `config.test.ts:6` can pass `{}` and
  `config.test.ts:15` can pass a fixture object. A pure function with its input
  injected is trivially testable — and that testability is a *design* property,
  not a testing trick. The docstring even says so: "The CLI passes process.env;
  tests pass a fixture" (`config.ts:8`).

- **The pool is injected into every persistence function** —
  `runMigration(pool, sql)` (`migrate.ts:8`), `loadProfile(pool, appId)`
  (`profile.ts:4`), `indexDocumentRow(pool, ...)` (`runtime.ts:5`),
  `new PgVectorStore({ pool, ... })` (`pg-vector-store.ts:25`),
  `new SupabaseTraceSink({ pool, ... })` (`supabase-trace-sink.ts:25`). None of
  them reaches for a module-level singleton connection. The test owns the pool,
  the test ends the pool (`after(async () => { await pool.end(); })`). No hidden
  global state to reset between runs.

- **`runMigration` is split from its CLI entrypoint** (`migrate.ts:8` is the
  pure function; `migrate.ts:23` is the CLI guard). The test imports the
  function and never touches the CLI. If migration logic and `process.argv`
  parsing were fused, you couldn't test the migration without faking argv.

There is **no untestable code reachable only through elaborate setup** in
`src/`. The hardest setup in the suite is "open a pool and run one migration,"
which is intrinsic to integration testing a database, not a smell. This is a
cross-link, not a finding to re-audit here → see
`.aipe/study-software-design/` for *why* injected dependencies and pure
functions are deep-module design. The testing observation is just: it paid off.

---

## 4. determinism-isolation-and-flakiness

The lens that decides whether a green run means anything.

**Determinism: strong, by construction.** The ranking assertion is the place
flakiness would hide, and it's been engineered out. `pg-vector-store.test.ts:24`
builds one-hot vectors: `vec(5)` is 768 zeros with a 1 at index 5. Querying
`vec(5)` against stored `vec(5)` gives cosine similarity exactly 1.0; against
`vec(200)` (orthogonal) exactly 0.0. The assertion `hits[0].id === 'planted#0'`
(`pg-vector-store.test.ts:37`) can't flip on a rerun — the math is exact, not
"close enough." The fake embedder (`runtime.test.ts:14-17`) returns the same
constant vector every call, so indexing is deterministic too. **No time, no
randomness, no network** in any assertion.

**Isolation: handled by `app_id` scoping.** Every DB test partitions its rows
under `app_id = 'test'` and cleans that partition in `beforeEach`:

- `pg-vector-store.test.ts:19-21` — `delete from agents.chunks where app_id = 'test'`
- `runtime.test.ts:25-28` — deletes both `chunks` and `documents` for `'test'`
- `supabase-trace-sink.test.ts:18-20` — `delete from agents.conversations where app_id = 'test'`
  (messages cascade via the FK at `001_agents_schema.sql:42`)
- `profile.test.ts:17` — one-shot delete in `before` (not `beforeEach`; see below)

The `'test'` namespace is disjoint from production's default `'laptop'`
(`config.ts:12`), so running the suite against a real `reindb` won't clobber
real data — a genuinely good safety property worth naming.

**Three real isolation observations, ranked:**

1. **`profile.test.ts` packs two assertions into one ordering-dependent
   `it`.** `profile.test.ts:22` asserts empty-string-when-none, then
   `profile.test.ts:23` inserts and `profile.test.ts:24` asserts the match —
   inside a *single* test, and the cleanup is a one-shot `delete` in `before`
   (`profile.test.ts:17`), not `beforeEach`. Run the file twice without the
   delete and the first assertion fails because a row survives. It's correct as
   written, but it's the one test whose correctness depends on statement order
   within the body rather than on isolated setup. Splitting it into two `it`s
   with a `beforeEach` cleanup would make it order-independent.

2. **Cross-file shared database, serialized by `--test-concurrency=1`.** All
   five DB files hit the same Postgres. They don't collide only because the
   runner executes files one at a time (`package.json:8`) *and* because they
   touch different tables / the same `'test'` namespace. Drop the
   `--test-concurrency=1` flag and `pg-vector-store.test.ts` and
   `runtime.test.ts` — both mutating `agents.chunks` under `app_id='test'` —
   could interleave their `beforeEach` deletes against each other's upserts.
   The flag is load-bearing for isolation, not just for log readability. Worth a
   comment in `package.json` saying so.

3. **"Green by skipping" is the flakiness trap inverted.** On a machine with no
   `DATABASE_URL`, five of six files skip (`migrate.test.ts:11`, etc.) and the
   run is green having asserted almost nothing. That's not flakiness — it's the
   opposite, a suite that can't fail because it didn't run. The danger is the
   same: a green check that trains you to trust it. → see
   `01-env-gated-integration-tests.md`.

---

## 5. edge-cases-and-error-paths

The happy path is covered everywhere. The error branches are covered in exactly
one place, and it's the right one.

**The one error path that's tested — and it's the load-bearing invariant.**
`pg-vector-store.test.ts:42-46` asserts both `upsert` and `search` *reject*
with `/dimension/` when handed a 3-element vector. This pins the
must-not-change constraint from `context.md` ("Embedding dimension is 768
everywhere; a mismatch must throw, never silently truncate"). The guard it
tests is `PgVectorStore.assertDim` (`pg-vector-store.ts:32-36`), called on every
vector before any SQL runs (`pg-vector-store.ts:39`, `:68`). This is exactly the
error path worth testing: a silent dimension mismatch would corrupt the index
with garbage rows. Testing the throw is testing the corruption-prevention.

**Error branches NOT exercised:**

- **`runMigration`'s rollback path** (`migrate.ts:13-16`). The `try/begin/commit`
  succeeds in the test; the `catch/rollback` is never driven. A test that feeds
  `runMigration(pool, 'create table x (bad syntax')` and asserts the transaction
  rolled back (nothing partially created) would pin the transactional guarantee
  the function exists to provide. Currently `not yet exercised`.

- **The `meta`-coercion fallbacks in `PgVectorStore.upsert`**
  (`pg-vector-store.ts:44-46`): `docId` non-string → `null`, `chunkIndex`
  non-number → `0`, `text` missing → `''`. The `dimension mismatch` test passes
  `meta: {}` (`pg-vector-store.test.ts:44`) so these *run*, but nothing asserts
  the coerced row reads back as `null`/`0`/`''`. A boundary test that upserts a
  chunk with junk meta and reads back the defaults would pin them.

- **`loadProfile` empty case** IS tested (`profile.test.ts:22`,
  the `?? ''` at `profile.ts:7`). Good — that's the null branch covered.

- **`SupabaseTraceSink` full-signal capture — now covered.** This grew. The
  sink now persists *every* `CapabilityEvent` variant (`supabase-trace-sink.ts:53-84`):
  `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`.
  The second `it` (`supabase-trace-sink.test.ts:37-67`) emits one of each and
  asserts the full payload survives: `tool_call_start` args land in `tool_calls`
  (`:54`), `tool_call_end` keeps `durationMs: 42` + `error: 'boom'` (`:56-57`),
  `model_usage` sums `inputTokens + outputTokens` into the once-orphaned
  `tokens_used` column as `123` and records the `gemma2:9b` model (`:59-60`),
  `warning`/`error` rows land at all (`:62-63`), and `created_at` is driven from
  the event timestamp so replay order matches emit order (`:65-66`). → see
  `05-full-signal-trace-capture.md` for the deep walk.
  The one still-uncovered branch: the *negative* filter — a `step` with empty
  content is dropped (`supabase-trace-sink.ts:58`), but no test emits one and
  asserts zero rows. The drop is `not yet exercised`.

No property-based testing anywhere — and at this size, none is warranted. The
one-hot vector trick is the closest thing to a property (orthogonality →
ranking), and it's sufficient.

---

## 6. testing-ai-features

The seam in practice. This is the most interesting lens for an AI repo, and
buffr handles it with a clear, deliberate split.

```
  Where the deterministic harness meets the probabilistic core

  ┌─ DETERMINISTIC — tested here with node:assert ──────────────┐
  │                                                              │
  │  indexDocumentRow ──► PgVectorStore.upsert ──► cosine rank   │
  │       ▲                                                      │
  │       │ fake embedder (constant 768-dim vector)              │
  │       │ runtime.test.ts:14-17                                │
  └───────┼──────────────────────────────────────────────────────┘
          │  the seam: aptkit's EmbeddingProvider interface
  ┌───────▼─ PROBABILISTIC — NOT asserted, lives upstream ──────┐
  │  OllamaEmbeddingProvider (real nomic-embed-text, network)    │
  │  GemmaModelProvider (real gemma2:9b generation)              │
  │  scorePrecisionAtK / faithfulness  → @rlynjb/aptkit-core      │
  │  reported by src/cli/eval-cmd.ts, not unit-tested            │
  └──────────────────────────────────────────────────────────────┘
```

**What's done right — the boundary is testable and tested.** The repo puts a
deterministic harness around the indexing path by swapping the
*non-deterministic core* (the real embedder, which hits Ollama and returns
floats you can't predict) for a fake that returns a constant vector
(`runtime.test.ts:14-17`). That single substitution turns "did indexing work?"
from a probabilistic question into an `equals` assertion: a documents row exists
(`runtime.test.ts:36-37`), at least one chunk exists
(`runtime.test.ts:38-39`). → see `02-fake-embedder-injection.md`.

**The eval seam is correctly placed elsewhere.** Precision@k, recall@k, and
faithfulness are *evaluation* — "is the retrieval good enough," not "does it
equal X." They live in `@rlynjb/aptkit-core` (`scorePrecisionAtK`,
`scoreRecallAtK`, imported at `eval-cmd.ts:4`), scored against the labeled set
`eval/queries.json` over the `eval/corpus/` fixtures. `src/cli/eval-cmd.ts` is a
**reporting script** — it prints `mean P@1 ... mean R@3` (`eval-cmd.ts:33`),
asserts nothing, and is not in `test/`. This is the correct partition: the eval
half hands off to `study-ai-engineering`. Calling `eval-cmd.ts` a "test" would
be the mistake; the repo doesn't make it.

**The gap — the deterministic boundary of the *chat session* is untested.** The
seam that's tested is the *retrieval/indexing* boundary. The *agent* boundary
isn't, and it moved: `src/cli/ask-cmd.ts` is gone, replaced by
`createChatSession` (`session.ts:34-76`), which assembles a `RagQueryAgent` with
profile injection (`session.ts:47,57`), tool registration (`session.ts:43-44`),
trace capture (`session.ts:56-57`), and — new — episodic memory
(`session.ts:53`). The model output is probabilistic and rightly not asserted —
but the *wrapper* around it is deterministic and testable. The per-turn `ask()`
(`session.ts:60-71`) has a precise, assertable contract: it persists the user
turn *before* running the agent (`session.ts:61`), flushes the trace
(`session.ts:63`), then calls `memory.remember()` inside a `try/catch` that
**swallows** a memory failure (`session.ts:66-69`) — a deliberate "the turn
already succeeded, don't lose the answer" branch that no test drives. The trace
half IS covered (`supabase-trace-sink.test.ts` asserts the full event signal
lands), but `session.ts` is glued together only at runtime, never asserted. →
see `02-fake-embedder-injection.md` for the technique that would extend to cover
it: swap in a fake `ModelProvider` (returning a scripted tool-call + answer) the
same way the fake embedder is injected, then assert the user row, the swallowed
memory-failure branch, and the persisted trajectory.

---

## 7. testing-red-flags-audit

The consolidated checklist, marked against this repo.

```
  Red flag                                    verdict
  ────────────────────────────────────────────────────────────────
  Most complex code least tested              CLEAR — pgvector SQL
                                              is the most tested
  Over-mocking (testing the mock)             CLEAR — one double,
                                              at a real seam
  Inverted pyramid (all slow e2e)             CLEAR — no e2e at all
                                              (which is its own gap)
  Heavy setup to reach the code               CLEAR — pool+migrate
                                              is intrinsic, not a smell
  Tests depend on time/network/random         CLEAR — one-hot vectors,
                                              fake embedder, no clock
  Tests depend on run order                   MINOR — profile.test.ts
                                              packs 2 ordered asserts
                                              in one it (lens 4 #1)
  Zero tests on error branches                MINOR — dimension throw
                                              is covered; rollback,
                                              meta-coercion, sink
                                              filtering are not (lens 5)
  Flaky / passes-on-rerun                      CLEAR by construction —
                                              but "green by skip" is the
                                              inverted trap (lens 4 #3)
  No CI                                        PRESENT — green run on
                                              any non-laptop machine
                                              proves nothing
  LLM feature with no boundary test            PARTIAL — retrieval seam
                                              tested; chat-session assembly
                                              seam in session.ts is not
```

**The verdict, ranked.** For a single-device, single-author RAG agent at v0.0.0,
this is a *sound* suite — the design is testable, the one test double is honest,
the determinism is engineered not hoped-for, the must-not-change 768 invariant
is pinned, and the trace sink now captures the full event signal. The things to
fix, worst first:

1. **Cover `session.ts`'s deterministic wrapper.** The repo's main path moved
   from a one-shot `ask-cmd.ts` to a long-lived `createChatSession`, and the new
   per-turn `ask()` (`session.ts:60-71`) carries real logic — user-turn-before-
   agent ordering, trace flush, and a swallowed memory-failure branch — with
   zero tests. The technique already exists in the repo (fake provider at a real
   seam, `runtime.test.ts:14-17`); extend it with a fake `ModelProvider`. This
   is the new highest-leverage move.

2. **Get the DB tests running somewhere that isn't your laptop.** A local
   Postgres+pgvector container in a CI job, or even a documented
   `DATABASE_URL`-set pre-commit, so a green check means the integration tests
   *ran*, not that they skipped. Until then, the suite's value is gated behind a
   manual setup only the author has.

3. **Add the remaining error-branch tests** (rollback, meta-coercion defaults,
   sink empty-`step` drop) — each is ~5 lines and each pins a guarantee the
   code already provides but doesn't defend.

Everything else (extract a shared DB helper, split `profile.test.ts`, comment
the `--test-concurrency=1` invariant) is polish.

---

Updated: 2026-06-24 — reconciled to current code: 9 tests/9 pass; `ask-cmd.ts`
deleted → `session.ts`/`chat.tsx` (`npm run chat`) named as the new #1 untested
gap across lenses 1/2/6/7; lens 5 trace-sink rewritten as full-signal capture
(now covered, → `05-full-signal-trace-capture.md`); `package.json` test-script
line refs corrected to :8; verdict re-ranked with session coverage as the
highest-leverage move.

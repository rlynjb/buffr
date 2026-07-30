# Pass 1 — the NFR audit (8 lenses)

DDIA 2e Ch 2 framework applied to buffr-laptop. Each lens gives a verdict (pass / meets-partially / not-yet-exercised / gap), the evidence, and the next action. This file does not re-teach mechanics — it cross-links to the deep-walk sibling that owns that lens.

The repo context: single-device, single-user, local LLM (Ollama/Gemma), personal data (journal, health, fitness), no public surface. Many distributed-systems NFRs are not applicable at this scale. "Not yet exercised" is named honestly; "gap" means it's applicable and absent.

---

## Lens 1 — Functional requirements

**Verdict: pass**

The system delivers what it advertises:

- **Grounded chat** — `session.ask()` → agent loop → KB + web + RSS synthesis → answer rendered in OpenTUI. `src/cli/chat.tsx`, `src/runtime.ts`.
- **Corpus indexing (markdown)** — `npm run index` → `indexDocumentRow(sourceType:'markdown')` → documents + chunks. `src/cli/index-cmd.ts`.
- **DB indexing** — `npm run index:db` → 8-table DB_SOURCES → `sanitize()` → `indexDocumentRow(sourceType:'db')`. `src/cli/index-db-cmd.ts`, `src/db-sources.ts`.
- **Episodic memory** — `createConversationMemory` upserts each turn; resurfaces via same `search_knowledge_base` tool.
- **Profile personalization** — `loadProfile` → injected into system prompt.
- **Retrieval eval** — `npm run eval` → `precision@k` / `recall@k` over `eval/queries.json`.
- **Trajectory capture** — `SupabaseTraceSink` captures all 6 event types per turn.

What's not yet exercised (functional gaps, not NFR gaps):
- Faithfulness eval (`RubricJudge` built in aptkit, unwired in buffr).
- Streaming (spinner + live token count, but `stream: false`).
- Web-search retry / quota handling (Google 429 visible to agent, no recovery).

→ `study-ai-engineering/ai-features-in-this-codebase.md` for the full feature inventory.

---

## Lens 2 — Reliability

**Verdict: meets-partially**

DDIA's definition: correct and performant even when hardware, software, or humans fail.

**What works:**

- **Dimension guard.** `assertDim` (`packages/kernel/src/pg-vector-store.ts:32-36`) throws before any write if the embedding vector is the wrong length. Belt + suspenders: column type `vector(768)` catches anything that slips through at the DB layer.
- **Idempotent upsert.** Both `documents` and `chunks` use `ON CONFLICT (id) DO UPDATE`, so a re-index always converges to the right state — no duplicate rows, no orphaned half-writes on re-run.
- **Memory write is best-effort.** `session.ts:64-69` wraps `memory.remember()` in `try/catch` so a memory-write failure doesn't lose the user's answer. This is a reliability design decision: prefer answer-delivered-with-memory-hole over answer-lost-due-to-memory-error.
- **`sanitize()` strips UTF-16 surrogates.** Lone surrogates in journal entry text (emoji edge cases) would cause Postgres JSON to reject the row; `sanitize()` strips them before indexing. `src/cli/index-db-cmd.ts`.

**Where reliability is partial:**

- **Swallowed catch is untested.** The `try/catch` around `memory.remember()` deliberately eats the error — a correct reliability decision — but no test asserts that a throwing `remember()` still returns the answer. A test that swallows correctly is indistinguishable from one that swallows incorrectly, without the test. → `study-testing/audit.md §lens-5`.
- **Non-atomic document+chunk write.** `indexDocumentRow` writes the documents row (`txn 1`), then fires `pipeline.index()` for the chunks (`txn 2`). A crash between them leaves a documents row with zero chunks — indexed but unsearchable. Single-device CLI makes this low-risk; re-running `index`/`index:db` recovers it. → `study-data-modeling/audit.md §4`.
- **`sanitize()` is silent.** Surrogate-containing data is silently stripped with no warning. The user has no visibility into whether data was corrupted before ingestion. → `study-debugging-observability`.
- **Emulated tool calling.** Gemma's tool-calling is parsed JSON from prose — not structured output. A malformed tool call (wrong key, empty string) is accepted silently. → `study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`.

---

## Lens 3 — Scalability

**Verdict: not-yet-exercised**

DDIA: the ability to cope with increased load. Measure load first, then ask what happens when it grows.

**Load today:** single user, local CLI, ~O(hundreds) of documents, 8 DB tables. No concurrent requests. No multi-tenant surface. No SLO.

**What's been measured:** nothing formally. The HNSW index exists, `app_id` filter is indexed, but no latency baseline has been taken for search, indexing, or generation.

**First bottlenecks by scenario:**

| Scenario | First bottleneck | Second bottleneck |
|---|---|---|
| 10x document corpus (hundreds → thousands) | HNSW build time (offline, not online); chunk count → upsert batch size | Ollama embedding throughput (sequential per-chunk calls) |
| 10x DB table rows | `index:db` wall-clock (8 sequential round-trips × 10x rows × embedding per chunk) | Postgres connection pool saturation |
| Multi-device / second user | `app_id` is a shape-only tag (no RLS, no auth); both users' data mixes | Session-level thread safety: mutable trace slots not safe under concurrent `ask()` |
| Real-time chat at concurrency | Gemma context window limit (8192 tokens); `maxToolCalls:4`, `maxTurns:6` ceilings | Single Ollama instance; no request queue |

**Scalability patterns not yet exercised:** partition by `app_id` or `created_at`, batch embedding calls, HNSW partition index (per-tenant `WHERE app_id`), connection pooling tuning, query rewriting/caching.

→ `study-system-design/audit.md` for architecture-level analysis; `study-performance-engineering/` for measurement.

---

## Lens 4 — Maintainability (operability)

**Verdict: meets-partially**

DDIA: easy for ops to keep running. For a single-developer tool, "ops" is the developer maintaining their own instance.

**What works:**

- All indexing paths are named npm scripts: `npm run index`, `npm run index:db`, `npm run eval`.
- Migrations are idempotent — re-running `npm run migrate` is safe. → `study-data-modeling/audit.md §5`.
- Monorepo build order is explicit: `npm run build:packages` before `npm run build` (`package.json`).

**What's partial:**

- **No scheduler.** `index:db` must be triggered manually; no cron or watch mode.
- **No runbook.** When `index:db` hangs (e.g. DB query returns unexpected schema), there is no documented recovery procedure.
- **No alerting.** `sanitize()` silently strips data. A DB column rename causes `index:db` to return empty rows silently (the query succeeds, `toText()` produces empty strings, chunks are indexed with no content). No warning surfaces to the operator.
- **`src/cli/chat.tsx` bootstrap is not restartable without exit.** The OpenTUI session is process-lifetime; no reload mechanism.

---

## Lens 5 — Maintainability (simplicity)

**Verdict: meets-partially**

DDIA: easy for engineers to reason about. Essential complexity is inherent to the problem; accidental complexity is the enemy.

**What keeps it simple:**

- **Dependency injection throughout.** `loadConfig(env)`, `PgVectorStore(pool)`, `indexDocumentRow(pool, appId, pipeline, doc)`, `createChatSession(cfg)` — all take their dependencies as parameters. No module-global singletons. Easy to trace the call chain.
- **Clean module boundaries.** Monorepo packages (`@buffr/kernel`, `@buffr/connectors`, `@buffr/contracts`) are well-separated. `packages/*` builds are explicit and ordered.
- **`DbSource` as a data-config object.** 8-table indexing config lives in one array in `src/db-sources.ts` — no inheritance, no factory, just typed config objects with `query`, `toId`, `toText`. Adding a 9th table is one array entry.

**Where complexity accumulates:**

- **`session.ts` approaching god-class (~200 lines, `study-software-design/audit.md`).** It wires pool + store + pipeline + tool + model + memory + trace + 7 connector tools + mutable trace slots + callbacks. One more feature and it becomes hard to hold in context.
- **Emulated tool calling is hidden complexity.** Gemma has no native tool API. The agent parses JSON from prose output, with no schema validation. This is a semantic dependency on the model's output format that's invisible to the type system. → `study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`.
- **`taRef` typed `any`.** `const taRef = useRef<any>(null)` (`src/cli/chat.tsx`) — the ref to the textarea is compiler-blind. A rename of `.plainText`, `.setText`, or `.newLine` on the OpenTUI side fails silently at runtime. → `study-frontend-engineering/audit.md §lens-8`.

---

## Lens 6 — Maintainability (evolvability)

**Verdict: meets-partially**

DDIA: easy to change in the future as requirements shift.

**What makes it evolvable:**

- **One idempotent migration, transactional runner.** `sql/001_agents_schema.sql` + `src/migrate.ts` wraps in `BEGIN/COMMIT`, rolls back on error. Adding a new migration file is safe — the runner applies only the one file it knows about.
- **`source_type` column.** `documents.source_type` (`src/runtime.ts`) lets the corpus hold both `'markdown'` and `'db'` content without schema changes. Adding a third `sourceType` is a config addition.
- **`DbSource` config pattern.** New data tables are one array entry in `src/db-sources.ts` — no code change to the indexing pipeline itself.
- **`DataConnector<P,D>` interface.** The three web search connectors implement the same interface; adding a fourth is an interface implementation.

**Where evolvability is limited:**

- **No schema versioning beyond 001.** The runner always applies `001_agents_schema.sql` and relies on idempotency. A second migration file would require a `schema_migrations(version, applied_at)` table and an ordered runner. → `study-data-modeling/audit.md §5`.
- **`db-sources.ts` hardcoded schema.** The 8 table queries hardcode column names (`id`, `date`, `text`, etc. per table). A schema rename in `loopd` or `contrl` breaks `index:db` silently — the query still runs, `toText()` returns `undefined` values, and chunks are indexed with blank content.
- **`session.ts` tool list is compile-time.** All 6 tools are wired in `createChatSession`. Adding a conditional tool (`if (process.env.NEW_TOOL_KEY)`) is a `session.ts` edit — no plugin registry, no runtime discovery.

---

## Lens 7 — Latency and performance budgets

**Verdict: not-yet-exercised**

No latency baseline exists. No SLO. No performance test.

**Known latency sources:**

| Path | Latency driver | Measured? |
|---|---|---|
| `npm run index:db` | 8 sequential `pool.query()` + per-chunk Ollama embedding | No |
| `npm run index` | per-file read + per-chunk Ollama embedding | No |
| `session.ask()` | Gemma generation (local, no streaming) | Live token count only; no p50/p99 |
| `PgVectorStore.search()` | HNSW ANN scan; `app_id` filter post-applied | No |
| Web search tools | Network RTT to Brave/Google/Tavily | No; Google 429 observed |

**Architectural performance notes (not yet measured):**

- `index:db` fires 8 sequential `pool.query` calls. These could be parallelized with `Promise.all` — though the 8 tables are in two different schemas, and connection pool saturation is a real risk without a concurrency cap.
- Ollama embedding is called once per chunk, serially. Batch embedding API is available in Ollama (`/api/embed` with `input: string[]`) — unwired.
- `ContextWindowGuardedProvider({maxTokens:8192})` is the generation ceiling. If the system prompt + tool schemas + tool results + question exceeds 8192 tokens, the provider truncates or refuses. No test covers this boundary.

→ `study-performance-engineering/audit.md` for the measurement and optimization analysis.

---

## Lens 8 — Availability, security, privacy

**Verdict: gap**

This is the most significant NFR gap in the repo.

**Availability:**

- Single-device, process-level availability. No HA, no replica, no failover — appropriate for a personal CLI tool. Named honestly, not a defect.
- `ContextWindowGuardedProvider` prevents token overflow; `maxToolCalls:4`, `maxTurns:6` prevent runaway loops. These are the primary availability guardrails.
- Mutable trace slots (`currentOnStatus`, `currentOnTokens`) are not safe under concurrent `ask()` — a second call would overwrite the first's callbacks. Single-user assumption makes this safe today; a concurrent access path (e.g. a second terminal window) would cause silent callback misfiring.

**Security:**

- `app_id='laptop'` is a shape-only tag. No Row-Level Security on `agents.*` tables. Any Postgres connection with the right credentials can read all users' KB chunks, trajectory messages, and profiles. For a single-device personal tool, the machine IS the trust boundary — acceptable. The escalation path (cloud hosting, sharing) has no safe upgrade without RLS.
- DB credentials live in env vars (`DATABASE_URL`). No rotation mechanism, no expiry.
- Web search API keys live in env vars. No scoping, no audit log of which queries were made.
- The agent system prompt is built from `loadProfile()` — a **trusted text** seam. If the profile is ever attacker-controlled (e.g. synced from an untrusted source), it's a prompt-injection vector. → `study-security/audit.md`.
- `sanitize()` strips UTF-16 surrogates. This is a data-integrity measure, not a security measure — it does not guard against prompt injection via journal entry content.

**Privacy:**

- The KB holds personal journal entries (`loopd.entries`), nutrition logs, health habits, workout data. All stored in plaintext in `agents.documents` and `agents.chunks` with no encryption at rest beyond OS-level disk encryption.
- Web search API calls send query text to Brave/Google/Tavily. No PII scrubbing before query. Journal entry content retrieved by KB search could flow into a web search query through Gemma's tool call.
- `agents.messages` captures full trajectory — tool args, tool results, all Gemma output. Retention policy: none (rows accumulate).

→ `study-security/audit.md` for the full security lens.

---

## Lens 9 — Observability and cost

**Verdict: meets-partially**

**What's wired:**

- **Full trajectory capture.** `SupabaseTraceSink` writes all 6 `CapabilityEvent` types per turn to `agents.messages`: tool_call_start/end with `durationMs`, model_usage with token counts, warnings, errors. The capture is replay-ready.
- **Live TUI callbacks.** `onStatus`, `onTokens`, `onComplete` wire per-turn progress into the chat UI — the user sees tool status and live token accumulation.
- **Per-turn stats.** `formatStats(stats)` renders `durationMs`, `inputTokens`, `outputTokens` in the chat footer after each turn.

**What's missing:**

- **No dashboard.** The trajectory rows exist in `agents.messages` but no query, graph, or summary view. The replay runner is also unwired (aptkit has one; buffr doesn't use it).
- **`tokens_used` is a lossy sum.** The `agents.messages` column stores `input + output` in one integer — no way to reconstruct per-call breakdowns after the fact.
- **Web-search API costs untracked.** Brave, Google, Tavily all have per-call costs or quota limits. No tracking, no budget, no alert when a quota is exceeded (Google 429 was observed at setup).
- **No cost model.** Local Ollama inference is free, but there is no framework to add a dollar cost when a call transitions to a cloud model.
- **`sanitize()` strips silently.** Data lost to surrogate stripping is not logged.

→ `study-debugging-observability/audit.md` for the full observability analysis; `study-ai-engineering/ai-features-in-this-codebase.md §7` for the trajectory capture deep-walk.

---

## Capstone — NFR red-flags audit

The consolidated checklist, marked against this repo:

| NFR red flag | Firing? | Evidence |
|---|:---:|---|
| No functional spec / unclear what "correct" means | no | Features are clearly demarcated; AI features have known failure modes named |
| Reliability: swallowed catch with no test | **YES** | `session.ts:64-69` memory write catch — untested swallow (lens 2, testing §lens-5) |
| Reliability: non-atomic multi-write | **PARTIAL** | document+chunk two-transaction write — recoverable by re-index (lens 2, data-modeling §4) |
| Scalability: no load measurement | **YES** | no baseline, no SLO, no perf test (lens 3, 7) |
| Maintainability: god-class approaching | **WATCH** | `session.ts` ~200 lines; not there yet, named so it doesn't creep past it (lens 5) |
| Maintainability: schema rename breaks silently | **YES** | `db-sources.ts` hardcoded column names; `toText()` returns undefined on rename (lens 6) |
| Security: no auth, no RLS, app_id shape-only | **YES** | personal data in plaintext, no row-level security (lens 8) |
| Security: prompt injection seam | **PARTIAL** | `loadProfile` trusted text; only a risk if profile source is attacker-controlled (lens 8) |
| Observability: silent data loss | **YES** | `sanitize()` strips surrogates with no warning; no log (lens 9) |
| Observability: cost blind spot | **YES** | web-search API costs untracked; Google 429 observed (lens 9) |
| Testing: most important code least tested | **YES** | `session.ts` orchestrator has zero tests (study-testing §lens-7) |
| Testing: green-by-skip CI | **IMPROVED but YES** | Suite is 32 tests / 7 files (up from 9/6); 4 new always-run tests added; most DB-gated tests still skip without DATABASE_URL; no CI provisions Postgres (study-testing §lens-7) |

**4 firing (scalability baseline, schema-rename silent fail, no auth/RLS, sanitize silent loss), 2 WATCH/PARTIAL (god-class watch, prompt injection partial), 2 YES in testing (inherited from study-testing).**

The highest-leverage fixes are ordered in `00-overview.md`.

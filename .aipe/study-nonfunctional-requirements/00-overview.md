# NFR overview — buffr-laptop

One-page verdict table. Each lens maps to DDIA 2e Ch 2's three categories (reliability, scalability, maintainability), with additional lenses for what a senior reviewer would ask of an LLM-application-layer system.

---

## Verdict table

| Lens | Verdict | Controlling evidence | Deep-walk |
|---|---|---|---|
| 1. Functional requirements met | **pass** | chat answers, KB search, DB indexing, web connectors, memory, eval all wired | `study-ai-engineering/ai-features-in-this-codebase.md` |
| 2. Reliability | **meets-partially** | single-device, happy-path correct; swallowed `catch` in memory write, non-atomic document+chunk write | `study-testing/audit.md §lens-5`, `study-data-modeling/audit.md §4` |
| 3. Scalability | **not-yet-exercised** | single-user, no load measurement, no scaling plan; named gaps: global HNSW index, sequential DB round-trips in `index:db` | `study-system-design/audit.md`, `study-performance-engineering/` |
| 4. Maintainability — operability | **meets-partially** | `npm run index:db` wired; no scheduler, no alerting, no runbook | `study-debugging-observability/audit.md` |
| 5. Maintainability — simplicity | **meets-partially** | DI-clean modules; `session.ts` approaching god-class (~200 lines); emulated tool calling is a hidden complexity tax | `study-software-design/audit.md` |
| 6. Maintainability — evolvability | **meets-partially** | one idempotent migration; no schema versioning beyond 001; `db-sources.ts` hardcoded schema breaks silently on rename | `study-data-modeling/audit.md §5` |
| 7. Latency and performance budgets | **not-yet-exercised** | no baseline, no SLO; 8 sequential DB round-trips in `index:db`; one embedding call per chunk; no streaming | `study-performance-engineering/audit.md` |
| 8. Availability, security, privacy | **gap** | `app_id` shape-only (no RLS, no auth); personal journal data in KB; no rate-limiting, no secret rotation | `study-security/audit.md` |
| 9. Observability and cost | **meets-partially** | full `SupabaseTraceSink` trajectory; no dashboard; `tokens_used` lossy sum; web-search API costs untracked | `study-debugging-observability/audit.md`, `study-ai-engineering/ai-features-in-this-codebase.md §7` |

---

## Top 3 gaps

**Gap 1 — No auth, no RLS, app_id shape-only (`study-security`)**
Personal journal data, health records, and workout history are indexed into the KB. `app_id='laptop'` is a tenant tag, not a security boundary. No Row-Level Security policies, no auth gate, no secret rotation. Risk: local tool where the machine IS the trust boundary — acceptable for now, but the escalation path (multi-device, sharing, cloud hosting) has no safe upgrade.

**Gap 2 — Untested orchestrator, swallowed catch, green-by-skip CI (`study-testing`)**
`session.ts` — the most complex code in the repo — has zero tests. A `try/catch` in the memory write deliberately eats errors so a memory failure doesn't lose the user's answer, but no test asserts that swallow is correct. 7 of 9 tests skip without `DATABASE_URL`; CI never provisions Postgres. One test file for `session.ts` with injected fakes + a CI pgvector service container are the next-action fixes.

**Gap 3 — No latency baseline, no SLO, 8 sequential DB round-trips (`study-performance-engineering`)**
`npm run index:db` fires 8 separate `pool.query` calls against two schemas; no batch, no parallel, no measurement. The embedding path fires one Ollama call per chunk with no batch embedding. Neither path has a latency baseline. There is no performance SLO and no way to know if a code change regressed latency.

---

## Next actions (priority order)

1. Write one test file for `session.ts` using injected fakes — covers the orchestrator's happy path, the swallowed memory-catch, and the `setBusy` double-branch. ← `study-testing`
2. Add `DATABASE_URL`-provisioned Postgres to CI (pgvector Docker service container). ← `study-testing`
3. Measure `index:db` wall-clock time against the actual table row counts; establish the baseline. ← `study-performance-engineering`
4. Add RLS policy scoped to `app_id` once the escalation path (multi-device) is planned. ← `study-security`
5. Add `schema_migrations(version, applied_at)` table + ordered runner for when a second migration lands. ← `study-data-modeling`

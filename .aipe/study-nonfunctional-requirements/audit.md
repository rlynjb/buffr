# Pass 1 — the NFR audit (8 lenses)

DDIA 2e Ch 2 framework applied to buffr-laptop. Each lens gives a verdict (pass / meets-partially / not-yet-exercised / gap), the evidence, and the next action. This file does not re-teach mechanics — it cross-links to the deep-walk sibling that owns that lens.

The repo context, unchanged: single-device, single-user, local LLM (Ollama/Gemma), personal data (journal, health, fitness), no public surface. Many distributed-systems NFRs are still not applicable at this scale. What's new since the last sync (`dffe49d..HEAD`, 36 commits): an entire second engine (`@buffr/engine-market-research`), a decision-journal subsystem (`agents.decisions`, predict → reveal → promote → review), two new external connectors (Reddit search, Google Trends), a live per-step progress panel, and a 5-bug whole-branch review pass (`41ecce8`). Every one of the five sibling audits this spec cross-links into found real, substantive NFR movement — this is not a housekeeping update.

---

## Lens 1 — Functional requirements

**Verdict: pass**

The system still delivers what it advertises, and the surface grew by a full second product:

- **Grounded chat** — `session.ask()` → agent loop → KB + web + RSS synthesis → answer rendered in OpenTUI. `src/cli/chat.tsx`, `src/runtime.ts`. Unchanged.
- **Corpus indexing (markdown + DB)** — `npm run index`, `npm run index:db` (8-table `DB_SOURCES`). Unchanged.
- **Episodic memory, profile personalization, retrieval eval, trajectory capture.** Unchanged.
- **NEW — market-research engine (`/research`).** `MarketResearchEngine.collect()` / `.evaluate()` (`packages/engines/market-research/src/engine.ts:56-237`), driven by `research-flow.ts`'s 5-step CLI state machine: predict (raw evidence shown, no analysis) → reveal (score/gap/principle/reflection) → promote to a tracked decision.
- **NEW — investing engine (`/investing`)**, unchanged in shape from the prior cycle, now sharing the same `Collector`/`Analyzer`/`Scorer`/`Teacher` capabilities as market-research.
- **NEW — decision journal (`/review`).** `PgJournalStore` (`src/pg-journal-store.ts`) implements the `JournalStore` contract (`packages/kernel/src/journal/contracts.ts`) against `agents.decisions` (`sql/002_decision_journal.sql`): create, `listDue`, snooze, resolve. `review-flow.ts` surfaces due decisions one at a time.
- **NEW — two discovery connectors.** Reddit search (`RedditSearchConnector`, unauthenticated, "frequently 403s outright" per its own calling code) and Google Trends (`GoogleTrendsConnector`, scrapes an unofficial endpoint, now guarded against an HTML-instead-of-JSON response).
- **NEW — live progress panel.** A typed `ProgressEvent` stream (`engine-start`/`connector-start`/`connector-done`/`connector-failed`/`stage-start`/`stage-done`) threaded engine → session → flow → `chat.tsx`'s `ProgressPanel`.

What's not yet exercised (functional gaps, not NFR gaps): faithfulness eval (unwired), streaming (`stream: false`), automatic web-search fallback across providers.

→ `study-system-design/audit.md` lens 1–2 for the full component/flow inventory this cycle added.

---

## Lens 2 — Reliability

**Verdict: meets-partially — genuinely stronger in places, and carrying one real new cross-cutting gap.**

DDIA's framing: correct and performant even when hardware, software, or humans fail. Applying the three fault classes:

**Hardware/network faults — the strongest evidence, and the newest gap, live here.**

- **What's better:** the connection-pool teardown that used to be unbounded is now bounded — `close()` races `pool.end()` against a 1-second timeout, and `chat.tsx`'s exit handler adds a 1.5-second hard deadline, closed by `64f822f`/`9c1b1e6` after it could previously hang the whole CLI on `/exit`. → `study-performance-engineering/audit.md` lens 1, lens 5.
- **What's still open, and now bigger:** no timeout exists on any external call — not Ollama, not Postgres, not any of the five discovery connectors. This was always true; what changed is the blast radius. `Collector.execute` (`packages/capabilities/src/collector/index.ts:35-52`) fans out `Promise.all` across every configured source with real per-source `try/catch` — a connector that *throws* (429, refused connection, malformed body) is caught and downgraded to a `failed[]` entry, and the batch still completes. But `Promise.all` requires every promise to *settle*: a connector whose `fetch()` simply never resolves blocks the entire `/research` or `/investing` turn forever, silently discarding the other connectors' evidence even though they already succeeded. **This is the same finding named from two different angles by two sibling audits — worth naming once, here, as the reliability-NFR synthesis of both:** `study-networking/08-networking-red-flags-audit.md` ranks it R1, "highest consequence," because `Promise.all` "tolerates throws, not hangs"; `study-distributed-systems/audit.md` lens 1–2 frames the identical mechanism as this repo's first real partial-failure question, because it's the first place more than one remote is genuinely in flight at once. Same root cause (`Collector.execute`'s `fetch()` call with no `opts`/`AbortSignal`), same fix (`AbortSignal.timeout(ms)` threaded into the `fetch` call and into `agent.answer`), two independent audits converging on it as their #1 open item.
- The connector's failure classification is real, structured hardening on top of that gap, not a substitute for it: `optional: true` on every configured source today means a thrown failure degrades cleanly; a hung one still doesn't.

**Software faults — mostly caught this cycle by a method worth naming on its own.**

- `41ecce8` closed 5 integration-seam bugs in one whole-branch review pass, none of which had a stack trace or a bug report: an empty-input guard too broad for `/review`'s valid blank-note case; an unguarded `dueReviewCount()` promise that could crash the CLI pre-render on a fresh DB; `MarketResearchEngine.evaluate()`'s crash on an empty `findings` array (`.reduce()` guarded, degrades to `dimensionMatched: false` instead of throwing); and — the most reliability-relevant one — `InMemoryJournalStore.listDue()` performing its `open → review-due` side effect without the `userId`/`workspaceId` scoping that `PgJournalStore` always had, despite the `JournalStore` contract's own doc comment stating both implementations must agree. → full case study in `study-system-design/audit.md` lens 6 and `study-testing/audit.md` lens 7.
- The lesson that generalizes: a port's doc comment ("both implementations must do this identically") is a promise, not a guarantee — nothing in TypeScript enforces two adapters behind one interface actually agreeing on a side effect neither method signature names. The fix that closed it was a regression test, not a type. That's a reliability finding about the *testing* seam, not just the code — see the maintainability lens below for the compound risk.

**Human faults (operator error / operator-facing failure containment) — improved, still with the same accepted swallow.**

- **Swallowed catch is still untested.** `session.ts:64-69` wraps `memory.remember()` in `try/catch` — a correct reliability decision (don't lose an already-returned answer over a memory-write bug) — but still no test asserts a throwing `remember()` still returns the answer. `41ecce8` added a second, identically-shaped swallow (`dueReviewCount().catch(() => 0)` at startup) — the pattern is now used twice, tested zero times. → `study-testing/audit.md` lens 5.
- **UI-level error containment now covers both new flows.** `chat.tsx` catches rejections from `session.ask`, `activeFlow.controller.submit()`, and `controller.start()` for `/research` and `/review` — a rejection surfaces as an error turn instead of leaving the CLI stuck mid-flow. Real, but as `study-debugging-observability/audit.md` lens 3/6 notes, none of these caught errors persist anywhere durable — resilience without evidence.
- **Non-atomic document+chunk write** and **`sanitize()`'s silent stripping** are both unchanged from the prior cycle. → `study-data-modeling/audit.md` §4.

**Verdict rationale:** reliability moved in both directions this cycle. Genuine new hardening (bounded teardown, connector-throw isolation, two bug-fixes-with-regression-tests) sits next to a genuine new gap (the fan-out hang) that's structurally worse than what it replaced, because the blast radius went from "one dependency can hang" to "one of six can hang and silently cost you the other five's work."

---

## Lens 3 — Scalability

**Verdict: not-yet-exercised — and the load shape got more interesting without becoming measured.**

DDIA: cope with increased load; measure it first. **Load today, updated:** still single user, still local CLI, now also fanning out to up to five external web APIs concurrently per `/research` or `/investing` turn, plus a persisted decision journal.

**New scalability-relevant surface:**

- **The connector fan-out is a new load parameter this repo didn't have before.** `N` (configured discovery APIs, currently 2-5 depending on which keys are set) is now a dimension the system scales along, and it's untimed and unbounded — see lens 2/7.
- **The decision journal doubles down on the existing multi-user gap rather than closing it.** `agents.decisions` carries `user_id`/`workspace_id` columns (`sql/002:5-6`) that look like real multi-user support, but `session.ts` populates both from the same single `cfg.appId` value on every call (`session.ts:747-756,769-782,785-789`). `study-system-design/audit.md` lens 3/7 names this precisely: two users sharing this process today wouldn't just share a knowledge base (the known limitation), they'd share and could corrupt each other's decision journal — a more sensitive instance of the same convention-only isolation, and `41ecce8`'s `listDue` scoping bug (lens 2) is direct proof of how easily that convention breaks even inside a *single* adapter.

**First bottlenecks by scenario, updated:**

| Scenario | First bottleneck | Second bottleneck |
|---|---|---|
| 10x document corpus | HNSW build time; chunk upsert batch size | Ollama embedding throughput (sequential per-chunk) |
| 10x DB table rows | `index:db` wall-clock (8 sequential round-trips) | Postgres pool saturation |
| Multi-device / second user | `app_id` shape-only tag (KB); NEW: `agents.decisions` inherits the identical gap one level deeper | Session-level thread safety: mutable trace slots |
| Heavy `/research`/`/investing` usage (NEW) | Connector fan-out with no per-source timeout — one hung source stalls the whole turn | Discovery-API rate limits (Google: 100/day observed) |

**Scalability patterns still not yet exercised:** partition by `app_id`/`created_at`, batch embedding, per-connector concurrency caps, connection pooling tuning, query rewriting/caching (the connector *result* cache — see lens 7 — is a caching win, not a scalability one).

→ `study-system-design/audit.md` lens 7 for architecture-level bottleneck analysis; `study-performance-engineering/audit.md` for measurement; `study-distributed-systems/audit.md` for the fan-out framed as a coordination question.

---

## Lens 4 — Maintainability (operability)

**Verdict: gap — one item escalated from "meets-partially" to a named gap this cycle.**

DDIA: easy for ops to keep running.

**What still works, unchanged:** named npm scripts for every indexing path, idempotent migrations, explicit monorepo build order.

**What's newly a gap, not a deferred tradeoff:** the decision journal's `open → review-due` transition is a plain `UPDATE` fired only as a side effect of `listDue()` being called (`pg-journal-store.ts:86-92`) — there is no scheduled sweep, no cron, no background job. `study-system-design/audit.md` lens 5/8 is explicit that this is *not* a deliberately-accepted tradeoff the way single-device scale is: it's a straightforward consequence of the read-triggers-the-write shape, and it undermines the decision journal's own point. A decision whose `review_at` passes while the operator never runs `/review` simply never surfaces — no notification beyond a once-per-launch banner (`initialDueCount`, `chat.tsx:122-125`). For a feature whose entire value proposition is "come back and find out if you were right," a review that never gets surfaced is a review that never happens. This is an operability gap that is also a product-correctness gap — naming it here because it's the kind of NFR miss that's invisible until someone notices their oldest open decision has been sitting unreviewed for months.

**What's still partial, unchanged:** no runbook for `index:db` hangs, no alerting on `sanitize()`'s silent data loss, `chat.tsx`'s bootstrap is process-lifetime with no reload mechanism.

---

## Lens 5 — Maintainability (simplicity)

**Verdict: gap — escalated from meets-partially. This is the sharpest maintainability move of the cycle, and it compounds with a testing gap rather than standing alone.**

DDIA: easy for engineers to reason about; essential complexity vs. accidental complexity.

**What still keeps it simple, unchanged:** dependency injection throughout (`loadConfig(env)`, `PgVectorStore(pool)`, `createChatSession(cfg)`), clean monorepo package boundaries, `DbSource`/`DataConnector` as config-not-code extension points. **New and genuinely good:** the interactive-conversation problem that could have tangled `chat.tsx` the way its own bootstrap already has was solved *before* the tangle formed — `createResearchFlow`/`createReviewFlow` hold their multi-turn state in closures depending on nothing but an injected `ChatSession`, the same "depend on an injected interface" discipline applied correctly to a harder, stateful case. → `study-software-design/audit.md` lens 3.

**The finding that carries this lens: `session.ts` crossed from "watch" to "fires."** `study-software-design/audit.md`'s red-flags capstone marks God class / over-large module as **FIRES, escalated from WATCH, and the new worst offender** — `session.ts` is now 883 lines, 15 public methods (`ask`, `analyze`, `evalInvesting`, `evalResearch`, `suggestResearchTopics`, `connectorStatus`, `researchCollect`, `researchEvaluate`, `saveHypothesis`, `saveDecision`, `dueReviewCount`, `listDueReviews`, `snoozeReview`, `resolveReview`, `close`) spanning 4 largely unrelated domains (chat, investing, research, journal) behind one factory function, and callers already partition cleanly along those same domain lines with zero overlap — meaning the fix (four thin domain facades over one shared build-once context) is a clean, low-risk extraction, not a rewrite. `study-software-design/audit.md` names this its highest-leverage fix this cycle.

**This is not just a code-complexity finding — it's a maintainability-NFR finding with a compounding partner.** `study-testing/audit.md` lens 1/7 states plainly: `session.ts`'s interface grew from ~7 methods to 15 since the last cycle, and it gained **zero new tests** — while every other module in the monorepo (kernel, capabilities, connectors, both domain packs, both engines) gained real coverage in the same period. The two findings are the same risk seen from two lenses, not two separate footnotes: the file most in need of a safety net to refactor confidently is also the file with the largest and least-tested surface area, which means the highest-leverage maintainability fix (splitting `session.ts`) is also the riskiest one to do *without* first writing the tests that would catch a regression during the split. `study-testing/audit.md`'s own top recommendation — one test file for `session.ts` with injected fakes, the exact discipline `research-flow.test.ts`/`review-flow.test.ts` already demonstrate one layer up — is the prerequisite for `study-software-design/audit.md`'s recommended split, not an independent task. Sequence matters here: test first, then split.

**Other simplicity findings, updated:** emulated tool calling remains hidden complexity (unchanged); `AgentContext` construction is now hand-repeated at 4 call sites in `session.ts` (`study-software-design/audit.md` lens 8) — a symptom of the god-class row, not a separate root cause.

---

## Lens 6 — Maintainability (evolvability)

**Verdict: meets-partially — unchanged in overall shape, sharpened by one real contract-drift lesson.**

DDIA: easy to change as requirements shift.

**What makes it evolvable, extended this cycle:** the `DataConnector<P,D>` interface absorbed two new connectors (Reddit, Google Trends) as pure implementations, no changes to calling code. The `JournalStore` port (`packages/kernel/src/journal/contracts.ts`) let `PgJournalStore` and `InMemoryJournalStore` both land without touching `research-flow.ts`/`review-flow.ts`. `packages/capabilities/` — the whole `Collector`/`Analyzer`/`Scorer`/`Teacher` layer — was reused 100% unchanged for the second domain engine (`MarketResearchEngine`), proof the port/adapter shape pays off exactly where evolvability theory says it should. → `study-system-design/audit.md` lens 7.

**The evolvability lesson this cycle actually taught, worth stating as its own finding:** a shared interface's doc comment is not an enforced contract. `contracts.ts:61-66` states "both implementations must do this identically" for `listDue`'s side effect; `InMemoryJournalStore` silently drifted from that promise until `41ecce8` caught it by inspection, not by test failure. The fix wasn't a type change — TypeScript has no way to express "these two side effects must match" — it was a shared regression test run against both adapters. **The evolvability takeaway for this codebase specifically:** every port with more than one adapter (`VectorStore`, `CapabilityTraceSink`, and now `JournalStore`) carries this same latent risk, and only `JournalStore` has a test proving parity so far (`journal.test.ts:76-91`, `PgJournalStore`'s equivalent gap is named in `study-testing/audit.md` lens 5 as still open). Evolving a port safely, in this repo, requires a parity test per adapter pair — not just a comment.

**Still limited, unchanged:** no schema versioning beyond a hardcoded migration-file order, `db-sources.ts`'s hardcoded column names break `index:db` silently on a schema rename.

---

## Lens 7 — Latency and performance budgets

**Verdict: meets-partially — moved off "not yet exercised" for the first time, because one real budget landed.**

No p95/p99 target, no per-turn latency SLO, and generation cost is still dominated by `gemma2:9b` — all unchanged. What's new: **the pool-shutdown fix is, structurally, this repo's first latency budget**, even though nobody framed it as one when they wrote it. `close()`'s pool-shutdown race (1 second) and `chat.tsx`'s `forceExit` hard deadline (1.5 seconds) together assert "shutdown takes at most 1.5s, no matter what" — a worst-case bound on an operation is exactly what a budget is. → `study-performance-engineering/audit.md` lens 1, which names this precisely.

**The budget that's still missing, and matters more now:** the connector fan-out has the *identical shape* as the pool-shutdown problem — an operation with an unbounded worst case — and hasn't received the identical fix. `Promise.all` over N connector fetches waits for every source to settle with no per-source deadline (`packages/capabilities/src/collector/index.ts:35-49`); the same "bound the worst case" move that fixed pool teardown hasn't been applied here yet, even though it's the more consequential of the two (a hung connector blocks a live user's turn; a hung pool only blocks `/exit`). `study-performance-engineering/audit.md`'s red-flags capstone ranks this #3 overall and names it as new this pass, "didn't exist as a finding before the two research engines landed."

**Known latency sources, updated:**

| Path | Latency driver | Measured? |
|---|---|---|
| `npm run index:db` | 8 sequential `pool.query()` + per-chunk embedding | No |
| `session.ask()` | Gemma generation, no streaming | Live token count only, no p50/p99 |
| `/research`, `/investing` gather step (NEW) | `Collector.execute`'s `Promise.all` over 2-5 connectors — genuinely `max(latency)`, not `Σ(latency)`, when it doesn't hang | No — the live progress panel shows stage transitions, not durations |
| Connection-pool shutdown (NEW, bounded) | Race against 1s/1.5s timeouts | Yes — the bound itself is the measurement |

The measurement gap named in the prior audit is still the single highest-leverage fix, and it's sharper now: `durationMs` and `tokens_used` are written to `agents.messages` for `/ask` and never aggregated (`study-performance-engineering/audit.md` lens 2) — and for `/research`/`/investing`, as lens 9 below details, there is nothing to aggregate at all, because those calls never reach the trace sink in the first place.

→ `study-performance-engineering/audit.md` for the full measurement and optimization walk.

---

## Lens 8 — Availability, security, privacy

**Verdict: gap — the most significant NFR gap in the repo remains security/availability, and the specific highest-leverage item inside it moved this cycle.**

**Availability, updated:**

- Single-device process-level availability, unchanged, appropriate for a personal CLI.
- **New availability risk: the connector fan-out hang (lens 2/7) is, at bottom, an availability problem.** A wedged connector doesn't just cost latency — it makes `/research` and `/investing` unavailable for that turn with no way to cancel or recover short of killing the process, because there's no timeout to fall back on.
- **New availability risk: the missing review-due sweep (lens 4) is an availability gap on the decision journal's core promise** — a review that should surface never does, silently, unless the operator happens to run `/review`.
- Mutable trace slots remain unsafe under concurrent `ask()` — unchanged, still low-risk at single-user scale.

**Security — the highest-leverage item moved, and it's worth stating explicitly which one.** `study-security/audit.md`'s own verdict, up front: **the market-research and investing engines pull real third-party content (Reddit posts, including from r/wallstreetbets; Google Custom Search snippets) directly into the `Analyzer`/`Teacher` prompts with no sanitization and no tool-call boundary at all** (`packages/capabilities/src/analyzer/index.ts:73-90`, `.../teacher/index.ts:58-81`, sourced via `RedditSearchConnector`/`GoogleSearchConnector`). This is architecturally different from every other prompt-injection surface in the repo: the RAG chat agent's injection surface (indexed docs, memory, web-search *tool* results) is bounded by a real tool-scope policy and a turn cap — there is something to filter. This pipeline never puts a tool in front of the model at all, so there is no policy to attach a filter to; a manipulated `AnalysisFinding.score` flows deterministically through `Scorer` into `totalScore`, which the operator can promote into a persisted `agents.decisions` row they later stake a real decision against. `study-security/audit.md` rates this **Medium** — bounded by deterministic score-averaging across dimensions and by human review at the promote step (`research-flow.ts`), neither of which is a technical gate.

**Is this the highest-severity open NFR item across the whole repo? The call: no — it's the highest-severity item *within security specifically*, but not the single highest-severity NFR item overall, because of what lens 9 names next.** The prompt-injection path is bounded on three real axes today: it requires an adversary to already be posting to a public forum the operator chose to query; its output is diluted by averaging across dimensions unless multiple sources agree; and a human reviews the finding before it's promoted into a tracked decision. What isn't bounded, and what makes the *next* finding the actual top item: if that injection ever succeeds, there is **no durable record of what happened** — no trace of the Reddit post text, the prompt it was joined into, or the score it produced survives past the terminal's scrollback (see lens 9). The security gap is a bounded, detectable-in-principle risk; the observability gap is what removes the "detectable" half of that sentence. A Medium-severity injection surface with zero forensic trail is a worse combined posture than the injection surface alone — which is exactly the cross-cutting point this NFR audit exists to make. → `study-security/audit.md` lens 3, 7, 8 for the full walk.

**Privacy:** unchanged — personal journal/health/fitness content in plaintext, no PII scrubbing before it flows into a web-search query via a tool call, `agents.messages` retains full trajectory with no retention policy.

---

## Lens 9 — Observability and cost

**Verdict: split — meets-partially for `/ask`; gap for `/research` and `/investing`. This is the single most consequential finding in this audit, ranked above the security finding above for the reason stated there.**

**What's still wired, unchanged for `/ask`:** full `CapabilityTraceSink` trajectory (all 6 event types), live TUI callbacks, per-turn stats footer.

**What's genuinely new and good: the live progress panel.** A typed `ProgressEvent` stream now gives real per-stage visibility *while* `/research`/`/investing` run — you can watch a connector fail or a stage take longer than expected, live. This is real, and it's the correct scoping call: it's a perceived-latency and in-flight-debugging aid, not a durable record. → `study-debugging-observability/audit.md` lens 1/5.

**The finding: `/research` and `/investing`'s LLM calls are structurally untraceable, permanently, by design of the current contract — not as a bug in one call site.** `study-debugging-observability/audit.md`'s red-flags capstone ranks this **#1**, above even the repo's other known trace gaps, and states the reason precisely: `Analyzer` and `Teacher` (`packages/capabilities/src/analyzer/index.ts:115-123`, `.../teacher/index.ts:100-123`) both run through the identical `runAgentLoop` kernel `/ask` uses, but without passing a `trace` option — and `AgentContext` (`packages/contracts/src/index.ts:1`) carries only a `traceId: string`, a label with nowhere to write to, not a sink. This means:

- **You cannot debug a production incident in this feature.** If a `/research` run produces a bad score, a hung connector, or — per lens 8 — a successfully injected prompt, there is zero durable evidence of what the model saw, what it was asked, or what it returned. The only reproduction path is re-running the same topic and hoping the result is similar — a materially weaker guarantee than `/ask`'s full replay-from-`agents.messages`.
- **The gap is not visible from the UI, which makes it worse, not better.** The progress panel and the live token counter make the pipeline *look* observed while it runs — but per `study-debugging-observability/audit.md` lens 1, the live token counter is wired but never fires for these two engines, because there's no trace to drive it, and the moment the turn ends, the panel's state is gone unless it's still in scrollback.
- **This compounds directly with the security finding in lens 8.** A prompt-injection attempt against `Analyzer`/`Teacher` leaves no forensic trail even if it succeeds — no record of the Reddit post text, the constructed prompt, or the resulting score survives. The two findings are the same repo-shape from two different lenses: an entire feature area with no evidence trail, and an entire feature area with an adversarial input surface. Put together, they describe a feature that can be silently manipulated and cannot be audited afterward.
- **The fix is structural, not a call-site patch:** widen `AgentContext` to optionally carry a `CapabilityTraceSink` (mirroring how `RagQueryAgent` already receives one directly), or wire `trace` through `Analyzer`'s and `Teacher`'s constructors the way `session.ts` already wires it through the RAG agent.

**Cost, updated:** the connector-result cache (`CachedConnector`, 1-hour TTL, wrapping all 7 discovery connectors) is a genuine cost control that didn't exist last cycle — repeat `/research`/`/investing` calls for the same topic within an hour cost zero outbound calls. → `study-performance-engineering/audit.md` lens 6. What's still missing: no tracking of the five discovery APIs' quota/cost consumption (Google's 100/day quota has already been observed exhausted), and `tokens_used` remains a lossy sum with no per-call breakdown.

→ `study-debugging-observability/audit.md` for the full observability lens; `study-performance-engineering/audit.md` for the cost/caching walk.

---

## Capstone — NFR red-flags audit

The consolidated checklist, ranked by cross-cutting consequence rather than by which sibling audit found it — this is the synthesis this spec exists to produce.

| Rank | NFR red flag | Firing? | Evidence | Dimensions it spans |
|---|---|---|---|---|
| 1 | `/research`/`/investing` LLM calls leave zero durable evidence, ever | **YES — highest overall** | `analyzer/index.ts:115-123`, `teacher/index.ts:100-123`; `AgentContext` has `traceId`, no sink | observability × security × reliability × maintainability |
| 2 | Reddit/Google evidence enters the Analyzer/Teacher prompt with no sanitization and no tool-call boundary | **YES — Medium (security's own rating)** | `analyzer/index.ts:73-90`; `RedditSearchConnector` sources `r/wallstreetbets` | security × reliability |
| 3 | Connector fan-out has no per-source timeout; `Promise.all` tolerates throws, not hangs | **YES, cross-confirmed by 2 sibling audits** | `collector/index.ts:35-52`, no `AbortSignal` passed | reliability × availability × latency |
| 4 | `session.ts` god-object (883 lines / 15 methods) escalated to FIRES with zero new tests on the growth | **YES, compound** | `study-software-design` red-flags capstone; `study-testing` lens 1/7 | maintainability × testing/reliability |
| 5 | No scheduled sweep for due decision-journal reviews | **YES, not a deferred tradeoff** | `pg-journal-store.ts:86-92`, read-triggers-write only | availability × maintainability (operability) |
| 6 | Port doc-comment contracts (`JournalStore.listDue`) aren't enforced by TypeScript | **YES, caught once, not systemically guarded** | `contracts.ts:61-66`; caught by `41ecce8`, fixed by a test not a type | maintainability (evolvability) × reliability |
| 7 | `sanitize()` strips data silently, no warning | **YES, unchanged** | `src/cli/index-db-cmd.ts` | observability × reliability |
| 8 | No auth, no RLS, `app_id`/`user_id`/`workspace_id` shape-only, now on 2 tables | **YES, accepted-and-widening** | `sql/001`, `sql/002:5-6`; `session.ts:770-778` populates both from one value | security (deferred, correctly so at single-device scale) |
| 9 | Discovery-API cost/quota untracked across 5 providers | **YES, unchanged** | Google 100/day quota observed exhausted | cost |
| 10 | No latency SLO/p95, though the pool-shutdown bound is a first real budget | **PARTIAL — one budget landed** | `close()`/`forceExit` timeouts, `chat.tsx:464-466` | latency |

**5 unambiguous YES (1, 2, 3, 5, 6, 7, 8, 9 — eight, several newly named this cycle), 1 compound (4), 1 partial-improved (10).** The through-line across the top four: this cycle's two biggest structural additions — the market-research/investing pipeline and the decision journal — both shipped with real functional value and real new NFR debt in the same commits, and the debt clusters in exactly the two places you'd predict for an LLM feature bolted onto an existing agent stack without reusing its observability seam: you can't see what the new engines' models saw, and you can't stop a fan-out to external sources from hanging. Fixing #1 (thread `trace` through `Analyzer`/`Teacher`) is the cheapest of the top three and unlocks turning #2's severity claim from inference into evidence the next time this audit runs. The highest-leverage fixes, in priority order, are in `00-overview.md`.

# Study — Debugging & Observability (buffr-laptop)

How this repo reveals its own behavior in development and (eventually) production:
what evidence exists when an answer comes back wrong, slow, or empty, and what
doesn't exist yet.

This is an **audit-style** guide. Two passes:

- **Pass 1 — `audit.md`** walks 8 observability lenses against the real code,
  emitting `not yet exercised` honestly where the repo has no mechanism.
- **Pass 2 — pattern files** (`01-`…`05-`) each take one observability mechanism
  the repo actually exercises and walk it end to end.

## Reading order

1. `00-overview.md` — the evidence map, ranked findings, what's missing.
2. `audit.md` — the 8-lens walk. Read this to see the whole surface at once.
3. Pattern files, in order of consequence:
   - `01-trajectory-capture-as-observability.md` — the `messages` table **is** the
     trace store. This is the repo's one real observability mechanism.
   - `02-discarded-trace-signal.md` — full-signal capture. `durationMs`, tool args,
     `model_usage` tokens, and warning/error all reach the store (reframed 2026-06-24
     from the original drop-everything bug, which is now fixed; history kept inside).
   - `03-created-at-replay-ordering-gap.md` — client-timestamp ordering. Replay sorts
     by `event.timestamp`, surviving the concurrent flush (reframed 2026-06-24; the old
     server-`now()` scramble is fixed, with a residual same-millisecond tie noted).
   - `04-stdout-as-only-log.md` — `process.stdout.write` / Ink render is the logging story.
   - `05-eval-numbers-as-quality-signal.md` — P@1 / R@3 are the only quality signal,
     and they measure retrieval, not the answer.

## Where this sits — partition

```
  study-testing                 catches known failures before release.
  study-debugging-observability explains unknown behavior with evidence.   ← you are here
  study-performance-engineering measures bottlenecks.
```

## Cross-links to neighbors

- **`../study-testing/`** — the eval seam (P@1/R@3) is owned there as a correctness
  harness; here it's read as a *quality signal* you can observe. `02` and `05` lean on it.
- **`../study-distributed-systems/`** — the `created_at` ordering gap (`03`) is a
  concurrency / event-ordering problem; the distributed-systems guide owns the
  general "server clock vs logical order" lesson.
- **`../study-agent-architecture/`** — the agent loop that *emits* the
  `CapabilityEvent` stream lives there; here we only read what the sink does with it.
- **`../study-performance-engineering/`** — `durationMs` is latency evidence; that
  guide owns latency budgets. `02` explains why the evidence is currently unrecoverable.

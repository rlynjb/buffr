# 06 — Fixture-Based Scorer Accuracy

**Subtitle:** Golden-fixture eval for deterministic functions — write a JSON file with inputs + expected output, run the real function, assert within tolerance. No mocks, no DB, no LLM.

---

## Zoom out — where this pattern appears

```
  test/commands.test.ts:28-79
    ↕ loads
  packages/domain-packs/investing/eval/
    company-fixtures.json   ← inputs + expectedTotalScore per fixture
    etf-fixtures.json

    ↕ runs against
  packages/capabilities/src/scorer/
    Scorer.execute(ScorerInput, ctx): Promise<AgentResult<ScorerOutput>>
      → totalScore, confidence, metrics[]
      → deterministic: same inputs → same output, always
```

This is an eval pattern (does the function produce the right answer?) expressed as a test (fails the build if not). The fixture file is the single source of truth for what "correct" means.

---

## How it works

### Step 1: the fixture file

`packages/domain-packs/investing/eval/company-fixtures.json` is a JSON array:

```json
[
  {
    "description": "high-quality large-cap company — should score high",
    "findings": [
      { "dimensionId": "financials", "confidenceScore": 0.85, "positives": [...], "negatives": [...], "unknowns": [...] },
      ...
    ],
    "evidenceCount": 5,
    "expectedTotalScore": 72.5
  }
]
```

`expectedTotalScore` is calculated by hand (or by running a known-good version of Scorer) when the fixture is created. Once committed, it becomes the contract.

### Step 2: the test loads the fixture and runs the real function

```typescript
// test/commands.test.ts:29-53
const scorer = new Scorer();
const fixtures = JSON.parse(
  await readFile(
    new URL('../../packages/domain-packs/investing/eval/company-fixtures.json', import.meta.url),
    'utf8',
  ),
);
for (const fixture of fixtures) {
  const result = await scorer.execute(
    { findings: fixture.findings, scorecard: COMPANY_SCORECARD, evidenceCount: fixture.evidenceCount },
    evalCtx,
  );
  const delta = Math.abs(result.data.totalScore - fixture.expectedTotalScore);
  assert.ok(delta <= 0.01, `"${fixture.description}": expected ${fixture.expectedTotalScore}, got ${result.data.totalScore.toFixed(4)}, Δ ${delta.toFixed(4)}`);
}
```

The real `Scorer` class runs. No mocks. The `±0.01` tolerance handles floating-point rounding in the weighted sum without hiding meaningful drift. The `import.meta.url` resolution means the test finds the fixture regardless of which directory `node --test` is invoked from.

### Step 3: the fixture drives the TUI eval too

`session.evalInvesting()` runs the same load-and-score logic and renders the results as a human-readable table in the TUI (via `/eval`). The fixture file serves double duty: test assertion gate + interactive verification surface.

---

## When this pattern is the right call

Use fixture-based accuracy when:
1. The function under test is **deterministic** — same inputs, same output, always. If it calls an LLM, it's not deterministic; use a different pattern.
2. The output is **numeric** and has a "close enough" contract (a tolerance is meaningful). Exact equality on floating-point weighted sums is fragile.
3. The inputs are **representable as JSON** — no live network calls, no DB reads, no time-dependent values inside the function.
4. You want **the eval to double as a test** — one JSON file serves both the build gate and the interactive `--eval` command.

Do not use this pattern when the function calls an LLM (use synthetic event stream injection, as in `05-full-signal-trajectory-assertion.md`) or when the "correct" output requires a human judgment call that can't be pre-computed.

---

## Contrast with the environment-gated integration tests

| | Fixture-based scorer test | DB-gated integration test |
|---|---|---|
| DB required? | no | yes (`DATABASE_URL`) |
| LLM required? | no | no (fake embedder) |
| Runs in CI today? | yes (always-run) | no (no DB provisioned) |
| What it exercises | the math of Scorer + scorecard | the SQL of PgVectorStore |
| Fixture type | JSON file in the monorepo | real Postgres rows |
| Determinism | exact (within ±0.01 tolerance) | approximate (HNSW is ANN) |

The fixture-based test is the *faster, always-run* complement to the slower, environment-gated integration tests. Both are needed.

---

## Adding a new fixture

1. Construct `findings` that represent a case you want to assert (e.g., "a company with strong financials but weak moat").
2. Compute the expected score by hand or by running `scorer.execute` against your findings and inspecting the result.
3. Add the entry to the appropriate fixture JSON file.
4. Run `npm test` — if the new entry fails, your hand calculation was wrong, not the Scorer.

If the scorecard weights change, **all fixtures will fail** — this is the intended behavior. The fixtures are the scorecard's tests; they pin "what these weights mean" as a numerical contract.

---

## See also

- `test/commands.test.ts` — the test that runs the fixtures.
- `packages/domain-packs/investing/eval/` — the fixture files.
- `packages/capabilities/src/scorer/` — the Scorer implementation.
- `study-ai-engineering/ai-features-in-this-codebase.md` — Feature 10 (/eval command).
- `01-env-gated-integration-tests.md` — the contrasting pattern for DB-dependent tests.

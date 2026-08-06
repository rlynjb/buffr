# study-nonfunctional-requirements — buffr-laptop

The cross-cutting NFR audit. Eight lenses from DDIA 2e Ch 2: functional-requirements, reliability, scalability, maintainability, latency-and-performance, availability-security-privacy, observability-and-cost, and the red-flags capstone. Each lens is a verdict with evidence, not a deep-walk of the mechanics — those live in the sibling specs linked below.

## Reading order

1. `00-overview.md` — the one-page verdict table: which NFRs pass, which are gaps, the next action
2. `audit.md` — the full 8-lens walk, grounded in file:line

## Deep-walk siblings (this audit cross-links out, doesn't re-teach)

| Deep-walk sibling | NFR it owns |
|---|---|
| `study-security` | security · auth · PII · dependencies |
| `study-performance-engineering` | latency measurement · throughput · cost profiling |
| `study-debugging-observability` | logs · metrics · traces · incidents |
| `study-testing` | reliability testing · coverage · eval seam |
| `study-software-design` | maintainability (code-level) · complexity |
| `study-distributed-systems` | availability under partition |
| `study-system-design` | reliability / scalability architecture |
| `study-data-modeling` | schema evolution · evolvability |
| `study-networking` | timeouts · retries · fan-out failure shape (cross-linked for the connector-fan-out reliability finding) |

## What DDIA 2e Ch 2 says these mean

- **Reliability:** correct + performant even when hardware/software/humans fail.
- **Scalability:** ability to cope with increased load (measure the load first, then ask what happens when it grows).
- **Maintainability:** operability (easy for ops to keep running) + simplicity (easy for engineers to reason about) + evolvability (easy to change in the future).

buffr-laptop is single-device, single-user. Most "distributed" NFRs are not yet exercised and named honestly.

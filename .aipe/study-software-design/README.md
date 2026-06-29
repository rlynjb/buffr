# Study — Software Design (A Philosophy of Software Design, applied to buffr-laptop)

This guide audits **buffr-laptop** through the design primitives in John
Ousterhout's *A Philosophy of Software Design* (APOSD) — deep modules,
information hiding, complexity, layering, readability — and grounds every
finding in real files at real line ranges. It does not teach the book in
the abstract; it teaches what *your* code does with the book's ideas.

> **Source.** The primitives come from *A Philosophy of Software Design*,
> John Ousterhout (2nd ed., 2021). The ideas are taught here in original
> words and applied to your repo. Read the book for the full conceptual
> treatment — this guide is the application, not the textbook.

---

## The through-line

```
  Complexity is the enemy. Deep modules are the weapon.

  ┌─ a deep module ─────────────────────────────────┐
  │  small interface  ░░░░░░░░  (what callers see)   │
  │  ───────────────────────────────────────────    │
  │  big body         ████████████████████████████   │
  │                   ████████████████████████████   │  (what it hides)
  └──────────────────────────────────────────────────┘
       ▲                              ▲
       │                              │
   cheap to use                  pays its way:
   (1 line at the call site)     hides decisions you'd
                                 otherwise repeat everywhere
```

buffr's whole job is to take aptkit's in-memory `VectorStore` contract and
implement it over Postgres + pgvector *without the rest of the system
noticing the swap*. That is APOSD's central move — a deep module behind a
narrow interface — and it's the spine of this audit.

---

## Reading order

1. **`00-overview.md`** — the audit at a glance. The complexity profile,
   the three highest-cost hotspots, and a one-line verdict per primitive.
   Read this first; if you read nothing else, read this.
2. **`audit.md`** — Pass 1. The 8-lens APOSD walk, each lens grounded in
   `file:line` or honestly marked `not yet exercised`. The capstone lens
   is the red-flag checklist sorted by severity for this repo.
3. **Pass 2 — discovered patterns.** The design moves buffr makes
   deliberately, each a full concept file:
   - `01-adapter-behind-a-contract.md` — `PgVectorStore` implementing
     aptkit's `VectorStore` so the swap is invisible.
   - `02-pure-core-impure-shell.md` — `loadConfig` as a pure testable
     seam vs the CLIs that own all the I/O.
   - `03-dependency-as-a-boundary.md` — aptkit imported as a contract;
     conversation memory extracted *up* and re-consumed.
   - `04-sync-interface-async-work.md` — the trace sink's sync `emit()`
     queuing async DB writes drained by `flush()`.
   - `05-deep-session-facade.md` — `createChatSession` holding
     pool/agent/memory/conversation behind a 2-method `ask`/`close`.

---

## Cross-links

- **Learn the primitives** (book-style, abstract): `.aipe/read-aposd/`
  *(not yet generated in this repo — run `/aipe:read-aposd`)*.
- **System architecture** (services, boundaries, scale): a different
  altitude — `.aipe/study-system-design/`
  *(not yet generated — run `/aipe:study-system-design`)*. When a finding
  is about a service boundary or data-flow rather than a module/interface,
  it belongs there, not here.
- **Testing & the eval seam:** `.aipe/study-testing/`
  *(not yet generated — run `/aipe:study-testing`)*. The `loadConfig`
  pure-seam finding and the `test/` mirror are the design half of what
  that guide audits for coverage.

The rule when two guides want the same finding is **altitude**:
module / interface / complexity lives here; service / architecture lives
in system-design.

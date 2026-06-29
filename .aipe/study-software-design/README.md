# Study — Software Design (APOSD, applied to buffr-laptop)

This guide audits **buffr-laptop** through the design primitives in
John Ousterhout's *A Philosophy of Software Design* (APOSD) — deep
modules, information hiding, complexity, layering, readability — and
grounds every finding in a real file. It teaches the primitive briefly,
then spends its weight on what *your* code does with it: where it honors
the principle, where it leaks, and the specific move to fix it.

**Source:** John Ousterhout, *A Philosophy of Software Design* (2nd ed.).
The primitives are his; the words here are original; the findings are
about your code. Read the book for the full conceptual treatment — this
guide assumes you want the *application*, not the lecture.

## The through-line

```
  complexity is the enemy  ──►  deep modules are the weapon

  a deep module:  big behaviour behind a small interface.
                  functionality ÷ interface-size is high.

  buffr's best:   PgVectorStore — two methods (upsert/search),
                  and behind them: a transaction, a dimension
                  guard, JS→pgvector encoding, a cosine→similarity
                  flip, and a meta round-trip. That's depth.
```

Everything in this guide measures against that one idea. A module earns
its keep when it hides decisions the caller never has to learn.

## Reading order

```
  1. audit.md          ← START HERE. The 8-lens APOSD audit of the
                         whole repo. Ranked findings, file:line
                         grounding, the red-flag checklist.

  then the Pass 2 pattern files — the design MOVES this repo makes
  deliberately, each a deep walk:

  2. 01-adapter-behind-a-contract.md   PgVectorStore = the adapter
                                        behind aptkit's VectorStore port
  3. 02-pure-core-impure-shell.md      loadConfig (pure seam) vs the
                                        CLIs (the I/O shell)
  4. 03-dependency-as-a-boundary.md    depending on aptkit's contracts,
                                        and the memory engine extracted UP
  5. 04-sync-interface-async-work.md   SupabaseTraceSink = the observer
                                        (sync emit / async flush)
  6. 05-deep-session-facade.md         createChatSession = a deep facade
                                        behind ask()/close()
```

## Cross-links — what this guide does NOT cover

```
  ┌─ altitude split — who owns which finding ──────────────────┐
  │                                                            │
  │  study-system-design/   ARCHITECTURE altitude.            │
  │    03-provider-abstraction.md  — the same port/adapter     │
  │    shape, but as a SERVICE boundary + scaling story.       │
  │    This guide teaches it as a MODULE/interface move.       │
  │    Don't re-teach the architecture here; link there.       │
  │                                                            │
  │  study-testing/         CORRECTNESS altitude.             │
  │    loadConfig as a pure testable seam, PgVectorStore's     │
  │    DB-gated tests, the eval set — the design here EXISTS   │
  │    to make those tests possible; the test coverage and     │
  │    isolation story lives there.                            │
  │                                                            │
  │  read-aposd (the book)  THE PRIMITIVES themselves, taught  │
  │    abstractly. This guide APPLIES them; it doesn't define  │
  │    them.                                                    │
  └────────────────────────────────────────────────────────────┘
```

The rule when a finding could live in two places is **altitude**:
module / interface / complexity / readability → here; service /
architecture / scaling → `study-system-design`; test coverage and
isolation → `study-testing`.

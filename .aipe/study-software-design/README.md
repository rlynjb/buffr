# study-software-design — buffr-laptop

> Updated: 2026-06-24 — reconciled against current code: `ask-cmd.ts` deleted,
> chat wiring now in `src/session.ts` (deep module, `ask`/`close`) + Ink/React UI
> `src/cli/chat.tsx` (new ink/react deps); memory is aptkit's
> `createConversationMemory` with buffr's store injected up; trace sink handles all
> 6 event types; aptkit ^0.4.1. The three top fixes below are unchanged.

A software-design audit of **this repo** through the primitives in John
Ousterhout's *A Philosophy of Software Design* (APOSD): deep modules, information
hiding, complexity, layering, readability. The product is the **findings about
your code**, grounded in real `file:line` references — not a restatement of the
book.

> **Source.** The framework is APOSD (Ousterhout). This guide teaches the ideas
> in original words and points to `read-aposd` for the full conceptual treatment.
> Read the book — it's short and it's the substrate under every file here.

## The through-line

**Complexity is the enemy; the deep module is the weapon.** A deep module hides a
lot of behavior behind a small interface, so callers learn a few names and inherit
a lot of correctness. buffr is small but unusually well-shaped, and the reason is
structural: it implements `@rlynjb/aptkit-core`'s contracts instead of designing
its own interfaces. When the interface is decided *for* you, you can't leak — the
contract is an upper bound on how much complexity escapes upward.

## Reading order

```
  1. 00-overview.md                    ← orientation + ranked verdict + top fixes
  2. audit.md                          ← Pass 1: the 8-lens APOSD walk (the core)
  3. 01-adapter-behind-a-contract.md   ← Pass 2: PgVectorStore ⊳ VectorStore
  4. 02-pure-core-impure-shell.md      ←         loadConfig vs the cli/* edges
  5. 03-sync-interface-async-work.md   ←         trace sink emit() / flush()
  6. 04-dependency-as-a-boundary.md    ←         aptkit imported, never edited
```

Start with `00-overview.md` for the verdict, then `audit.md` for the full read.
The Pass 2 files are deep walks of the four design moves the repo makes
deliberately — read `04` first if you want the boundary that makes the others
possible, or `01` first if you want the single deepest module.

## What the file list tells you

The four pattern files *are* a teaching artifact — a senior engineer skimming them
learns what's interesting about buffr before opening anything:

- **adapter-behind-a-contract** — buffr's deepest module is a pgvector adapter
  behind an aptkit port.
- **pure-core-impure-shell** — config is a pure function; the CLIs are the
  effectful shell.
- **sync-interface-async-work** — the trace sink bridges aptkit's sync `emit` to
  async DB writes via a deferred `flush`.
- **dependency-as-a-boundary** — aptkit is a hard, immutable boundary, and that's
  what generates the design quality.

## Top 3 fixes (ranked across the repo)

1. **The dead `schema` knob.** `loadConfig` computes `cfg.schema`
   (`src/config.ts:13`) but every SQL string hardcodes `agents.` across five
   files. Pick a side: delete the field or thread it through. (audit Lens 3 + 5.)
2. **The undocumented `meta` contract.** `upsert` reads magic keys
   `docId`/`chunkIndex`/`text` off `meta` (`src/pg-vector-store.ts:44-46`) with no
   interface comment. Add one line. (audit Lens 7.)
3. **Unvalidated `k`.** `search` passes `k` straight to SQL `limit`
   (`src/pg-vector-store.ts:76`); clamp it `>= 1`. (audit Lens 5.)

## Honest scope — what this repo is too small to exercise yet

Named in the audit, not padded into fake findings: error aggregation /
special-case sprawl (Lens 6 — the error model is uniform "throw and bubble," which
is correct for a single-device CLI), deep multi-layer layering (the repo has 1-2
layers, not 5), and classitis (the one thin module, `db.ts`, is a test seam, not a
shallow abstraction). These become real as the codebase grows; the audit says what
to watch for.

## Cross-links

- `read-aposd` — the APOSD framework itself, taught in book form.
- `study-system-design` — the same repo at the architecture altitude (services,
  flows, scale) rather than module/interface level.
- `study-testing` — the injected pool and the pure `loadConfig` are the seams that
  make this repo testable; that guide is the payoff of this one's design.

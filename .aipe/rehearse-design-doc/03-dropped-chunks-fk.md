# DOC 03 — The Deliberately-Dropped chunks→documents FK

**Decision (one line):** `agents.chunks.document_id` has **no foreign key** to
`agents.documents` — on purpose. The FK is the obvious schema default; keeping it
would have given `PgVectorStore` a hidden precondition (a `documents` row must
exist before any chunk) that breaks drop-in parity with aptkit's `VectorStore`
contract. The contract wins; the FK goes. The *non-default* is the decision.

*Source: graduation spec "As-built deviations" (discovered during
implementation); `sql/001_agents_schema.sql:15-27`; `src/pg-vector-store.ts:43-56`.*

---

## 2. Context / problem

This is the doc for the decision a reviewer questions *most*, because it looks
like a mistake. Every instinct in relational modeling says: `chunks` has a
`document_id`, `documents` has an `id`, therefore add the foreign key. Referential
integrity is the default. The design spec itself originally drew it that way
(graduation spec, the `## Supabase schema` block shows `document_id` as a plain
link, and the FK was added during the first build).

Then implementation hit the wall. aptkit's `VectorStore` contract is
`{ dimension, upsert, search }`. The `upsert(chunks)` method has **no notion of a
documents row** — it takes chunks with vectors and metadata and writes them. The
in-memory store honors that: you can `indexDocument` and it upserts chunks with
nothing resembling a parent document record.

With a hard FK on `chunks.document_id`, `PgVectorStore.upsert` *can't* honor that
contract. The insert fails unless a matching `documents` row already exists. Two
concrete callers break:

1. **Memory rows.** `createConversationMemory` (DOC 02) upserts chunks tagged
   `kind='memory'` with `id` like `memory:<conv>:<n>`. There is *no document*
   behind a remembered conversation — it's not indexed from a markdown file. A
   hard FK makes every memory write fail.
2. **Drop-in parity.** The whole graduation thesis (DOC 01) is that
   `PgVectorStore` drops into the pipeline where `InMemoryVectorStore` sat, with
   zero agent changes. A store that *requires* a documents row first has a
   precondition the in-memory store doesn't — so it's no longer a drop-in.

---

## 3. Goals & non-goals

**Goals**

- `PgVectorStore.upsert` honors the `VectorStore` contract exactly — chunks go in
  with no documents-row precondition.
- Memory rows (no document behind them) can be written.
- The migration is idempotent for databases that already shipped *with* the FK.

**Non-goals**

- **Not abandoning the link.** `document_id` stays as a *soft link* — chunks
  still record which document they came from, for the chunks that have one. We're
  dropping the *constraint*, not the column.
- **Not enforcing referential integrity in app code instead.** No replacement
  check. The link is best-effort by design.
- **Not cascading deletes.** Without the FK there's no `ON DELETE CASCADE` from
  documents to chunks; reindex/delete is the store's job, named below.

---

## 4. The decision

Keep `document_id` as a nullable text column with **no FK constraint**. The DDL
even drops the constraint idempotently for already-migrated databases.

```
  The dropped FK — contract precondition vs. referential integrity

  WITH the FK (rejected)              WITHOUT the FK (chosen)
  ┌─ documents ─┐                     ┌─ documents ─┐
  │ id (PK)     │◄══ FK ══╗           │ id (PK)     │   soft link
  └─────────────┘         ║           └─────────────┘   (no constraint)
  ┌─ chunks ────┐         ║           ┌─ chunks ────┐        ▲
  │ document_id │═════════╝           │ document_id │┄┄┄┄┄┄┄┄┘ nullable,
  └─────────────┘                     └─────────────┘          best-effort
   upsert FAILS unless a               upsert ALWAYS works —
   documents row exists first          honors VectorStore.upsert
   → breaks contract parity            → memory rows (no doc) allowed
   → memory writes rejected            → drop-in parity preserved
```

The constraint that wins is **aptkit's `VectorStore.upsert`, not Postgres's
referential integrity.** That's the whole call: when a database-level invariant
contradicts a code-level contract you've committed to honor, and the contract is
the thing other code depends on, the database invariant yields.

**Where the soft link gets resolved:** `PgVectorStore.upsert` reads `docId` from
the chunk's `meta` and writes it into `document_id` when present, defaulting to
`null` when absent (`pg-vector-store.ts:44`,
`const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null`). Memory
chunks carry no `docId` in meta, so they land with `document_id = null` — exactly
the case a hard FK would have rejected.

**The DDL spells the decision out** (`sql/001_agents_schema.sql:16-27`): the
column comment says *"Soft link to documents.id (no FK): the VectorStore contract
upserts chunks with no notion of a documents row, so a hard FK would break
drop-in parity"*, and `alter table agents.chunks drop constraint if exists
chunks_document_id_fkey` removes it idempotently from any DB that shipped with it.

---

## 5. Alternatives considered

**Alternative A — keep the FK, make the `index` CLI write the documents row
first.**
This is what the first build did. The CLI writes the `agents.documents` row
before `pipeline.index` populates chunks. *Why it lost:* it only fixes the
*document-indexing* path. It does nothing for *memory* rows, which have no
document and never will. And it re-introduces the precondition the in-memory
store doesn't have, breaking parity for any caller that isn't the `index` CLI.
You'd be making the contract conditional on which caller you are.

**Alternative B — keep the FK, give memory rows a synthetic "memory" documents
row.**
Create a placeholder `documents` row so memory chunks have a parent to point at.
*Why it lost:* it's a fiction to satisfy a constraint. You'd insert fake document
rows whose only purpose is to keep the FK happy, then carry them forever. The
constraint would be driving the data model instead of describing it.

**Alternative C — split the stores: a real FK on document chunks, a separate
table for memory.**
Two tables, integrity where it applies. *Why it lost:* it breaks DOC 02's whole
design — memory rides the *same* store as documents *specifically* so it surfaces
through the existing `search_knowledge_base` tool. Two tables means two stores
means the memory engine can't share retrieval with documents. The soft link keeps
one store, one retrieval path.

---

## 6. Tradeoffs accepted

- **We chose the soft link, accepting no database-enforced referential
  integrity.** A `chunk.document_id` can point at a `documents.id` that doesn't
  exist (or got deleted) and Postgres won't stop it. We took that because the
  alternative — a precondition on every upsert — breaks the contract that makes
  the whole graduation a drop-in.
- **We chose no `ON DELETE CASCADE`, accepting that deleting a document doesn't
  auto-delete its chunks.** Reindex and cleanup are the store's responsibility
  now, not the database's. For a single-device corpus that's re-indexed
  wholesale, that's cheap; it's named so nobody assumes a cascade that isn't
  there.
- **We accept that the column can hold a dangling reference** in exchange for
  memory rows being first-class citizens of the same table.

---

## 7. Risks & mitigations

```
  Risk → mitigation

  dangling document_id        → tolerated by design. The link is best-effort;
   (no FK to catch it)          retrieval doesn't depend on the documents row
                                existing — search reads content/meta off the
                                chunk itself (pg-vector-store.ts:71-84).

  orphaned chunks after a      → reindex is first-class (DOC 01): a model/corpus
   document is removed           change re-embeds wholesale rather than relying
                                 on cascade deletes. Single-device scale makes
                                 this cheap.

  a future reader re-adds the  → the DDL drops the constraint idempotently AND
   FK "to be correct"            the column carries an inline comment explaining
                                 why it's gone (sql/001_agents_schema.sql:16-18).
                                 The decision is documented at the schema, not
                                 just here.
```

---

## 8. Rollout / migration

- **The idempotent drop:** `alter table agents.chunks drop constraint if exists
  chunks_document_id_fkey` runs in the migration. Databases built *before* this
  change (which shipped *with* the FK) get it dropped; fresh databases never
  create it (the `create table` omits the `references` clause). One DDL handles
  both states (`sql/001_agents_schema.sql:26-27`).
- **For callers:** strictly loosening. Any upsert that worked before still works;
  upserts that the FK *rejected* (memory rows, chunks-before-documents) now
  succeed. Nothing that depended on the constraint existed — it was a constraint
  in the way, not a constraint in use.
- **For data in flight:** existing chunk rows keep their `document_id` values
  untouched; only the constraint is removed.

---

## 9. Open questions

- **Should the soft link ever become a checked invariant again?** If a second
  app writes documents and chunks transactionally, an FK *might* be safe for the
  document-indexing path while memory rows stay exempt. That needs a way to
  exempt memory rows from the constraint (partial FK / separate path) — undecided
  and not needed at one device.
- **Cleanup policy for orphaned/memory chunks.** With no cascade, there's no
  automatic GC. Same retention question as the trajectory tables and memory rows
  — open.

---

## Coach notes — where a reviewer pushes, and the framing that holds

- **"You dropped a foreign key — that's a data-integrity smell."** This is the
  one objection you *will* get, and the answer is the strongest signal in the
  doc: "I dropped it deliberately. The FK gave the store a hidden precondition —
  a documents row must exist first — that the `VectorStore` contract doesn't
  have. Memory rows have no document at all, so the FK made every memory write
  fail. The contract is load-bearing; the FK wasn't." Naming a constraint you
  *removed on purpose*, with the exact caller it broke, is how you prove you
  designed it twice instead of defaulting.
- **"Then how do you prevent dangling references?"** Don't pretend you do: "I
  don't enforce it — it's a best-effort link. Retrieval reads off the chunk, not
  the document, so a dangling link never breaks a query. Enforcement would cost
  the parity I needed; I priced it and passed." Owned, not hand-waved.
- **The borderline-doc reminder** (from the overview): the *trace sink* is an
  adapter behind a contract, so it folds into a paragraph. *This* clears the bar
  because it's a non-obvious choice against the obvious default, it's
  cross-cutting (memory, indexing, parity all ride on it), and it's the first
  thing a reviewer questions. That contrast — same repo, one folds and one
  docs — is itself the lesson in telling load-bearing decisions from tidy ones.
- **The sentence that gets the yes:** *"The FK is the default; honoring aptkit's
  `VectorStore` contract is the requirement. When they collided, I kept the
  contract and dropped the FK — and wrote the reason into the schema so nobody
  adds it back."*

---

## See also

- DOC 01 — the `VectorStore` drop-in parity this FK would have broken.
- DOC 02 — the memory rows (no documents row) the dropped FK makes possible.
- The folded borderline case: the full-signal trace sink
  (`src/supabase-trace-sink.ts`) — see `00-overview.md`, "why it's NOT its own
  doc."
- `.aipe/study-data-modeling/03-soft-link-no-fk.md`,
  `07-non-atomic-document-chunk-write.md`.

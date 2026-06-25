# Design Doc — Dropping the chunks→documents Foreign Key

> **Summary:** `agents.chunks.document_id` is a **soft link** to
> `agents.documents.id` — deliberately *no* foreign key. The FK was in the
> original design; it was dropped during implementation because it gave the
> store a hidden precondition (a documents row must exist before any chunk),
> which broke drop-in parity with aptkit's `VectorStore` contract. The drop
> also enables conversation-memory chunks to exist with no documents row at
> all.

**Status:** Shipped — as-built deviation, verified live 2026-06-19.
**Grounds:** `sql/001_agents_schema.sql:14-27`, `src/pg-vector-store.ts:44-55`,
graduation spec "As-built deviations."

---

## 2. Context / problem

The original schema had the obvious, correct-looking FK:
`chunks.document_id references documents(id)`. Every chunk belongs to a
document; the FK enforces it. Textbook normalization.

It broke on contact with aptkit's `VectorStore` contract. That contract's
`upsert(chunks)` knows nothing about a documents row — it takes chunks with an
id, a vector, and meta, and writes them. aptkit's own `indexDocument` upserts
chunks *without* ever creating a documents row; the documents row is a buffr
concept, written by buffr's `index` CLI, not by the store. So a hard FK gave
`PgVectorStore.upsert` a precondition the contract never promised: **a parent
documents row must already exist.** Any caller using the store the way aptkit
defines it — including aptkit's own code path — would hit a foreign-key
violation.

The FK turned a clean adapter into one with a hidden ordering dependency. That
is exactly the drop-in parity (doc 01) the whole graduation was built to
preserve.

> **Coach:** The instinct in the room will be "wait, you *dropped* a foreign
> key? That's a code smell." Get ahead of it. Don't defend the absence —
> reframe it as protecting a contract. "I dropped the FK to *keep* an
> invariant: the store behaves identically to the in-memory one. The FK was
> the thing breaking the invariant." A removed safeguard that *protects a
> contract* is a design decision, not a shortcut.

---

## 3. Goals & non-goals

**Goals**
- `PgVectorStore.upsert` works for any chunk the `VectorStore` contract
  permits — including chunks whose document_id points at no row yet, or at no
  row ever.
- Enable conversation-memory chunks (`kind=memory`) to live in the chunks
  table with **no** documents row (doc 02 depends on this).
- Keep the link usable for the common case (chunk → its source document) when
  the documents row does exist.

**Non-goals**
- Not abandoning referential thinking entirely — `document_id` still carries
  the link; it's just not *enforced*.
- Not solving orphan cleanup in this phase (named as a tradeoff, below).

---

## 4. The decision

Keep `document_id` as a plain `text` column — a **soft link**, no FK
constraint. The migration drops the constraint idempotently so already-migrated
databases converge.

```
  Soft link, not enforced — chunks can exist without a documents row

  ┌─ agents.documents ─┐         ┌─ agents.chunks ──────────────┐
  │ id   text  PK      │◄┄┄┄┄┄┄┄ │ document_id  text  (NO FK)   │
  │ content            │  soft   │ id "<doc>#<idx>"  PK         │
  │ source_type        │  link   │ embedding vector(768)        │
  └────────────────────┘         │ meta.kind                    │
        ▲                        └──────────────────────────────┘
        │                                  ▲
        │ corpus chunk: document_id        │ memory chunk:
        │ points at a real row             │ document_id = null,
        │ (link resolvable)                │ no documents row exists
        └──────────────────────────────────┘ (the FK would have rejected this)

  ┄┄┄ = link by value, not enforced by the database
```

The boldface of the design: the database stops asserting "every chunk has a
parent document." That assertion was *false* for memory chunks and
*order-dependent* for corpus chunks. Dropping it makes the chunks table mean
exactly what the `VectorStore` contract means — a flat bag of embedded chunks
— while still recording the document link when there is one.

In the store, `upsert` resolves `document_id` from `meta.docId` when present
and writes `null` otherwise (`src/pg-vector-store.ts:44-55`) — no lookup, no
precondition, no ordering requirement.

> **Coach:** Have the one-line idempotent migration ready to point at:
> `alter table agents.chunks drop constraint if exists chunks_document_id_fkey`
> (`sql/001_agents_schema.sql:27`). The `if exists` is the tell that you
> thought about already-deployed databases — it's a no-op on a fresh DB and a
> fix on an old one. Reviewers notice that detail.

---

## 5. Alternatives considered

**A — Keep the FK, make the `index` CLI always write the documents row first.**
Preserve integrity by ordering writes. Lost because it only fixes *buffr's*
call path — aptkit's own `indexDocument`, and any other contract-conforming
caller, still upserts chunks with no documents row and still violates the FK.
You can't fix a contract violation by being careful in one caller; the
contract permits the thing the FK forbids.

**B — Keep the FK, give memory chunks a synthetic "memory" documents row.**
Insert a placeholder documents row so memory chunks have a parent. Lost because
it's a fiction — a documents row that describes no document, created only to
satisfy a constraint. It pollutes the corpus table, and the placeholder shows
up in any query over documents. Inventing rows to satisfy an FK is a sign the
FK is modeling the wrong thing.

**C — Split memory into its own table, keep the FK on corpus chunks.**
Two tables: `chunks` (FK enforced) and `memory_chunks` (no FK). Lost because it
breaks the single-store property doc 02 depends on — memory surfaces through
the *same* `search_knowledge_base` tool precisely because it's in the *same*
table. Splitting tables means two retrieval paths, two HNSW indexes, and a
union query. The shared store is the feature; the FK isn't worth losing it.

> **Coach:** Alternative C is the one a database-minded reviewer prefers —
> "separate concerns into separate tables." Concede the instinct, then name
> what it costs: "separate tables means memory no longer rides the existing
> retrieval tool — I'd need a second search path and a union. The single store
> is what makes recall free. I traded an enforced FK for one retrieval path."
> That's a trade you can defend; "I didn't feel like adding a table" is not.

---

## 6. Tradeoffs accepted

- **We chose the soft link, accepting that orphaned chunks are now possible.**
  Cost: delete a documents row and its chunks dangle with a `document_id`
  pointing at nothing; the database won't stop it. Owned: at single-device
  scale with a CLI-driven corpus, orphans are a cleanup script, not a
  correctness bug — and the alternative (an FK that breaks the contract) was
  worse.
- **We chose value-linking over database-enforced integrity, accepting that
  the link's validity is now the application's job.** Owned deliberately: the
  `VectorStore` contract is the integrity boundary here, not the FK. Moving the
  invariant from the database to the contract is the decision, stated plainly.

---

## 7. Risks & mitigations

- **Risk: orphaned chunks accumulate after document deletions.**
  *Mitigation:* none enforced this phase — named as a tradeoff, not hidden.
  Cleanup is a `delete from chunks where document_id not in (select id from
  documents)` script when it matters. Deferred honestly.
- **Risk: a future reader assumes the FK exists and writes code relying on
  cascade deletes.** *Mitigation:* the schema comment states the drop and *why*
  inline (`sql/001_agents_schema.sql:15-17`), so the decision is discoverable
  at the point of confusion.

---

## 8. Rollout / migration

- The drop is **idempotent and backward-safe**:
  `drop constraint if exists chunks_document_id_fkey`
  (`sql/001_agents_schema.sql:27`). On a fresh DB the FK was never created (the
  current schema declares `document_id` with no FK); on a DB migrated under the
  old design, the constraint is dropped. Either way the post-state is identical.
- For callers: nothing changes. `upsert` already wrote `document_id` from
  `meta.docId`; the only difference is the database no longer rejects a null or
  dangling value.
- Data in flight: existing chunk rows keep their `document_id` values
  untouched; only the constraint enforcing them is removed.

---

## 9. Open questions

- **Orphan policy.** When (if ever) does buffr add a cleanup pass or
  soft-delete for chunks whose document was removed? Undecided — deferred until
  corpus churn makes it matter.
- **Does the soft link survive RLS?** When RLS lands at app #2, both tables get
  `app_id` policies independently. A soft link across two RLS-gated tables
  could resolve to a row the policy hides. Worth checking before multi-tenant.

---

## See also

- `01-pgvector-graduation.md` — the drop-in parity this decision protects.
- `02-aptkit-memory-extraction.md` — the memory chunks this drop enables (no
  documents row).
- `.aipe/study-data-modeling/` — the integrity-and-constraints lens auditing
  this same tradeoff.

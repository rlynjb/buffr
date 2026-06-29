# Soft link, no foreign key

**Industry name(s):** soft reference / application-level (logical) foreign key
— here the foreign key (the dropped `chunks.document_id` link). **Type:**
Project-specific (a deliberate denormalization of referential integrity).

---

## Zoom out, then zoom in

You know what a foreign key does: `chunks.document_id references documents(id)`
would make Postgres *guarantee* every chunk points at a real document, and
refuse to delete a document that still has chunks. This file is about a schema
that had exactly that foreign key — and then deliberately *dropped* it. The
interesting part is why dropping a safety constraint was the right call.

```
  Zoom out — where the (absent) foreign key would sit

  ┌─ aptkit contract (VectorStore) ──────────────────────────┐
  │  upsert(chunks)  ── knows nothing about a documents row   │ ← the reason
  └───────────────────────────────┬───────────────────────────┘
                                  │  PgVectorStore.upsert
  ┌─ Postgres (agents schema) ────▼───────────────────────────┐
  │  documents (id PK)                                        │
  │      ╎  chunks.document_id ──► NO foreign key here         │ ← the seam
  │      ╎  (constraint dropped, 001:26-27)                    │
  │  chunks (document_id text, nullable)                      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "should the database enforce that every chunk has a
parent document?" The textbook answer is yes. The right answer *here* is no —
because two things this repo needs would break under a hard foreign key: drop-in
parity with aptkit's in-memory store, and memory chunks that legitimately have
no document. The soft link keeps the *column* (you can still join on it) while
dropping the *constraint* (the database stops enforcing it).

---

## The structure pass

```
  One axis: "what enforces that document_id points at a real document?"

  ┌─ documents ──────────────────────────────────────────────┐
  │  id text primary key                                      │  the target
  └─────────────────────────┬────────────────────────────────┘
                            ╎  seam: the constraint that WOULD live here
                            ╎  is DROPPED — axis answer flips to "nothing"
  ┌─ chunks ────────────────▼────────────────────────────────┐
  │  document_id text  (nullable, no FK)                      │  enforced by:
  │   corpus chunk  → document_id = "<docId>"  (points real)  │  NOTHING in DB
  │   memory chunk  → document_id = null       (no parent)    │  (app convention
  └──────────────────────────────────────────────────────────┘   only)
```

The axis is **what enforces referential integrity**. Across the seam at
`chunks.document_id` the answer flips from "the database would" to "nothing
does." That flip is the whole concept — it's a load-bearing boundary because the
guarantee you'd assume (every chunk has a document) is *not* there, and code that
assumes it would be wrong.

---

## How it works

### Move 1 — the mental model

Think of a TypeScript `string` that *holds* a user id versus a branded
`UserId` type the compiler *checks*. The soft link is the former: `document_id`
is just a `text` column holding what is usually a real `documents.id`, but the
database doesn't check it, the way a plain `string` doesn't prove the user
exists. You keep the ability to join; you give up the guarantee.

```
  Hard FK vs soft link — what the database promises

  HARD FK:   chunks.document_id ──► documents.id   (CHECKED)
             • insert chunk w/ missing doc → ERROR
             • delete doc w/ live chunks   → ERROR (or cascade)

  SOFT LINK: chunks.document_id ┄┄► documents.id   (NOT checked)
             • insert chunk w/ missing doc → OK  ← needed for memory
             • delete doc w/ live chunks   → OK, chunks orphan silently
             • you can still JOIN on it when both exist
```

### Move 2 — the load-bearing skeleton

This concept has a kernel: one `alter table ... drop constraint` line and the
two capabilities it unlocks. Isolate it, name each part by what breaks if it's
missing.

**Part 1 — the dropped constraint (the kernel).** One idempotent line:

```sql
-- sql/001_agents_schema.sql:14-27
create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts chunks
  -- with no notion of a documents row, so a hard FK would break drop-in parity.
  document_id text,                 // ← plain text, declared with NO references clause
  ...
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;  // ← the kernel
```

The table is *created* with `document_id` as plain `text` (no `references`),
and the `alter ... drop constraint if exists` cleans up any database that was
migrated back when the FK existed. The `if exists` makes it safe to run on a
fresh database (no constraint to drop) and an old one (drops it) alike. **What
breaks if this line is missing:** databases migrated under the old schema keep
the hard FK, and the two capabilities below start throwing.

**Part 2 — drop-in parity with the in-memory store (what the FK would break).**
`PgVectorStore` implements aptkit's `VectorStore` interface
(`pg-vector-store.ts:19`). That contract's `upsert(chunks)` receives chunks and
nothing else — no documents row, no parent. The in-memory implementation just
stores them. If the Postgres implementation demanded a matching documents row
(via a hard FK), it would *not* be a drop-in replacement — code that worked
against the in-memory store would throw a foreign-key violation against the
Postgres one. **What breaks if the FK is present:** the substitutability that's
the entire point of the `VectorStore` seam.

```
  Drop-in parity — why a hard FK breaks the contract

  ┌─ aptkit VectorStore (the port) ──────────────────────────┐
  │  upsert(chunks: Chunk[])  ── no documents row in scope    │
  └──────┬───────────────────────────────────┬───────────────┘
         │ in-memory adapter                  │ PgVectorStore adapter
         ▼                                    ▼
   stores chunks, done             with HARD FK: throws if no
                                   documents row → NOT a drop-in
                                   with SOFT link: stores, parity kept
```

**Part 3 — memory chunks with no document (what the FK would forbid).**
Episodic memory rides the same `chunks` table (`session.ts:53`,
`createConversationMemory({ embedder, store })`). A memory chunk
(`"memory:<conv>:<n>"`) is a past exchange embedded for recall — it has *no*
source document, so its `document_id` is `null`. A hard FK with a `not null`
parent would forbid this row entirely; even a nullable FK column adds nothing
here. **What breaks if the FK is present:** memory can't share the document
store, and the whole "memory resurfaces through the same `search_knowledge_base`
tool" design falls apart. The session comment says it directly:

```ts
// session.ts:50-53
// Sharing the document store means memory surfaces via the existing
// search_knowledge_base tool — and memory chunks live with no documents
// row, which the dropped FK allows.
const memory = createConversationMemory({ embedder, store });
```

**The hardening that's NOT in the kernel — and the cost it leaves.** The price
of dropping the FK is real and worth naming: nothing in the database stops a
chunk from pointing at a deleted document, and deleting a documents row silently
orphans its chunks (no cascade, no error). On a single-device personal tool
driven by a human, that's an accepted cost — re-indexing is cheap and the
natural key (`02-deterministic-chunk-ids.md`) makes it idempotent. The
buildable hardening, if integrity ever matters more: a periodic reconciliation
sweep that deletes chunks whose `document_id` is non-null and missing, run in
app code since the DB no longer guards it.

**This compounds with the non-atomic write.** The soft link is also what makes
the cross-transaction document+chunk write (`audit.md` §4) *recoverable*: when
`indexDocumentRow` writes the documents row in one transaction and the chunks in
another (`runtime.ts:11,17`), a crash between them leaves a document with no
chunks — but because there's no FK, re-running the index just upserts the
missing chunks with no constraint to fight. The soft link turns a would-be
integrity violation into a benign retry.

### Move 3 — the principle

A foreign key is a guarantee you pay for — and like any guarantee, it's only
worth it if you actually need it *and* can afford its constraints. Here the
constraint (every chunk needs a real document) conflicts with two real
requirements (contract parity, parentless memory chunks), so the right move is
to keep the *column* as a soft link and drop the *constraint*. The lesson
isn't "FKs are bad" — it's that referential integrity is a tradeoff, not a
default, and a soft link is the honest name for "I want to join on this but I
can't promise it's always valid." When you drop a FK, you've moved the
enforcement from the database into your head — say so, and have a plan for the
orphans.

---

## Primary diagram

```
  Soft link, no FK — the full picture

  ┌─ aptkit VectorStore contract ────────────────────────────┐
  │  upsert(chunks)  ── no documents row → FK would break it  │
  └───────────────────────────────┬───────────────────────────┘
                                  │  PgVectorStore.upsert
  ┌─ agents schema ───────────────▼───────────────────────────┐
  │  ┌ documents ┐         ┌ chunks ───────────────────────┐  │
  │  │ id PK     │┄┄┄┄┄┄┄┄┄│ document_id text (NO FK, 001:27)│  │
  │  └───────────┘ soft    │  corpus → "<docId>"            │  │
  │                link    │  memory → null  ◄── FK forbids  │  │
  │                        └────────────────────────────────┘  │
  │  enforcement: NOTHING in DB · app convention + idempotent  │
  │  re-index (natural key) cover the gap                      │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

"Soft foreign key" / "logical foreign key" is a recognized pattern — common in
sharded systems (you can't FK across shards), in microservices (the parent
lives in another service's database), and in exactly this case, pluggable
storage behind a contract that doesn't know about the parent. The discipline it
demands: the integrity the database used to guarantee now has to be guarded
somewhere you control, or accepted as best-effort. This repo accepts it as
best-effort, which is defensible for a single-device tool and would not be for a
billing system.

The trust/security angle — that `app_id` is *also* not enforced (no RLS) — is a
sibling decision; see `04-app-id-tenant-column.md` and **study-security**.

---

## Interview defense

**Q: You dropped a foreign key. Defend it.**
The `chunks` table sits behind aptkit's `VectorStore` contract, whose
`upsert(chunks)` knows nothing about a parent document — a hard FK would make
the Postgres store throw where the in-memory store doesn't, breaking drop-in
parity (`pg-vector-store.ts:19`). And episodic memory chunks legitimately have
no document, so their `document_id` is null — a FK would forbid them. I kept the
column as a soft link so I can still join when both exist; I gave up the
database guarantee because two real requirements conflict with it. The cost —
orphaned chunks on document delete — is accepted because re-indexing is
idempotent via the natural key.

```
  Q: why drop the FK?
  hard FK breaks:  ① VectorStore drop-in parity (upsert has no doc)
                   ② memory chunks (document_id = null)
  soft link keeps: the join column, minus the guarantee
  cost owned:      orphans on delete → idempotent re-index covers it
```

**Q: What did you give up, and where does the enforcement go now?**
Database-enforced referential integrity for chunks. Deleting a document no
longer errors or cascades — it silently orphans the chunks. The enforcement
moved from the database into application convention plus the idempotent
re-index path. If integrity ever mattered more, I'd add a reconciliation sweep
in app code; I wouldn't re-add the FK, because that re-breaks parity and memory.
That "the enforcement moved into my head" is the load-bearing admission — a soft
link without a plan for orphans is just a bug with a nice name.

---

## See also

- `02-deterministic-chunk-ids.md` — the natural key that makes orphan-recovery cheap
- `04-app-id-tenant-column.md` — the sibling "shape without enforcement" decision
- `06-trajectory-tables.md` — the memory chunks the soft link enables
- `audit.md` §4 — transactions-and-integrity, the non-atomic write this interacts with
- **study-system-design** — the VectorStore contract / drop-in-parity seam

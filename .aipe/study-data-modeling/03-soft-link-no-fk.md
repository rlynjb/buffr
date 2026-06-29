# 03 · Soft link, no FK

**Subtitle:** a referential column with the foreign-key constraint deliberately
dropped — relationship-by-convention instead of relationship-enforced —
*Project-specific*.

---

## Zoom out, then zoom in

`chunks.document_id` points at `documents.id` — but there's no foreign key making
that pointer mean anything to the database. It's a *soft link*: a column that
*looks* like a relationship and is treated like one by app code, while the DB
itself enforces nothing.

```
  Zoom out — where the (missing) constraint sits

  ┌─ App layer ─────────────────────────────────────────────┐
  │  runtime.indexDocumentRow  → writes documents + chunks   │
  │  PgVectorStore.upsert      → writes chunks (any doc_id)   │
  │  @aptkit/memory            → writes chunks (NO doc at all)│
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Storage: agents ─────────▼─────────────────────────────┐
  │  documents.id  ◄- - - - - chunks.document_id              │
  │                  ★ SOFT LINK — FK dropped ★               │ ← here
  │  (compare: messages.conversation_id ═══► REAL FK below)   │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question is "who guarantees that `chunks.document_id` points at a
real document?" The answer here is *nobody* — and that's on purpose. The FK was
present, then explicitly dropped, so that the `chunks` table can serve as a
drop-in `VectorStore` whose contract has no notion of a `documents` row at all.

## The structure pass

One axis: **integrity guarantees** — what does the DB promise vs what does app
code merely hope? Trace it across the two relationships in this schema and watch
the promise flip.

```
  axis = "does the DB enforce this relationship?"

  ┌─ chunks → documents ───────────┐   DB promise: NONE
  │  document_id text  (soft link) │   → app code must keep it honest
  └────────────────┬────────────────┘
                   │ seam: this is where the design
                   │       chose parity over enforcement
  ┌─ messages → conversations ─────┐   DB promise: FULL
  │  conversation_id uuid          │   → references + on delete cascade
  │    references conversations    │
  └─────────────────────────────────┘

  same schema, two relationships, opposite guarantees — that contrast is the lesson
```

The seam is the deliberate asymmetry. The trajectory cluster gets a real FK with
cascade (delete a conversation, messages vanish). The retrieval cluster
*removes* its FK. Same database, opposite integrity contracts — and the reason is
the `VectorStore` interface boundary.

## How it works

### Move 1 — the mental model

The shape is a **pointer the runtime trusts but the type system doesn't check** —
like a string id you pass around in app code where a typo compiles fine and only
explodes at runtime. The DB *could* check it (that's what a FK is); the design
chose not to let it.

```
  soft link vs hard link (pattern)

  HARD (FK):   chunks ──[constraint]──► documents
               insert with bad doc_id → DB REJECTS it
               delete document → DB blocks or cascades

  SOFT (here): chunks ──[just a column]─ documents
               insert with bad doc_id → DB ACCEPTS it
               insert with NULL doc_id → fine (memory chunks)
               delete document → chunks dangle, DB silent
```

### Move 2 — the walkthrough

**The constraint, explicitly removed.**
The schema doesn't just *omit* the FK — it actively drops it, idempotently, so
that databases created before this decision get repaired too.

```
  File: sql/001_agents_schema.sql
  Lines: 14-27

    create table if not exists agents.chunks (
      id text primary key,
      -- Soft link to documents.id (no FK): the VectorStore contract
      -- upserts chunks with no notion of a documents row, so a hard
      -- FK would break drop-in parity.
      document_id text,              ← plain column, no `references`
      ...
    );
    alter table agents.chunks
      drop constraint if exists chunks_document_id_fkey;   ← repair old DBs
```

Line 19: `document_id text` — no `references agents.documents(id)`. The comment on
17-19 is the *why* written into the schema. Line 27 is the migration carrying its
own forward-fix: any DB that still has the old FK loses it on the next run.

**Why the FK had to go: the `VectorStore` contract.**
The aptkit `VectorStore` interface speaks in chunks with `id`, `vector`, `meta` —
there is no `documents` row in its world. If `chunks.document_id` had a NOT-NULL
FK, you couldn't upsert a chunk without first creating a document, and the
in-memory store has no documents to create. The dropped FK is what keeps
`PgVectorStore` a true drop-in.

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.upsert
  Lines: 43-56

    const docId =
      typeof c.meta.docId === 'string' ? c.meta.docId : null;  ← may be NULL
    ...
    insert into agents.chunks (id, document_id, ...) values ($1, $2, ...)
                                                                   └─ no FK
                                                                      to satisfy
```

Line 44: `docId` is `null` when the chunk has no `meta.docId`. With a NOT-NULL
FK this insert would fail. Without it, the chunk lands fine — which is exactly
what the next part needs.

**The payoff: memory chunks with no document at all.**
Conversation memory rides the *same* `chunks` table, tagged `meta.kind='memory'`,
with ids like `"memory:<conv>:<n>"` and **no** `document_id`. There is no
`documents` row for a remembered exchange — there never will be. The dropped FK
is what lets these chunks exist.

```
  File: src/session.ts
  Lines: 49-53

    // memory chunks live with no documents row, which the dropped FK allows.
    const memory = createConversationMemory({ embedder, store });
                                                        └─ same PgVectorStore
```

```
  Layers-and-hops — two chunk populations, one table

  ┌─ runtime ─────┐ hop1: index(doc)   ┌─ chunks ──────────────┐
  │ indexDocument │ ─────────────────► │ document_id = "doc#0" │ has a doc
  └───────────────┘                    │  ─ soft link ─►       │
                                       │ documents row exists  │
  ┌─ session ─────┐ hop2: remember()   │                       │
  │ memory engine │ ─────────────────► │ document_id = NULL    │ NO doc
  └───────────────┘                    │ id "memory:conv:0"    │ ever
                                       └───────────────────────┘
        the FK would have rejected the NULL row → it's gone on purpose
```

**The boundary condition — the cost you accepted.** With no FK, the DB will
never stop you from: inserting a chunk whose `document_id` names a document that
doesn't exist; deleting a document and leaving its chunks orphaned. Both are now
*app-code* responsibilities. `indexDocumentRow` keeps them honest by writing the
document first (`runtime.ts:11`) — but nothing in the database *forces* that
order, which is the same hole `07-non-atomic-document-chunk-write.md` walks from
the transaction angle.

### Move 2 variant — the load-bearing skeleton

```
  the kernel of "soft link"
    1. a column that names another table's key
    2. NO referential constraint on it
    3. app code that maintains the relationship by convention
    4. a deliberate reason the constraint is absent (here: drop-in parity)
```

- Keep **(1-3)** without **(4)** and it's just a missing FK — a bug.
- **(4)** is what makes it a *pattern* instead of an oversight: the absence is
  load-bearing, documented in the schema comment, and enables the NULL/memory
  rows.
- Add the FK back and you break the `VectorStore` contract and lose memory chunks
  — so the constraint's absence is the feature.

### Move 3 — the principle

A foreign key is a guarantee you buy with flexibility. Most of the time you want
to buy it — referential integrity is cheap correctness. But a constraint is also
a coupling: it forces an ordering and a parent-must-exist rule on every writer.
When a table has to satisfy an interface that doesn't know about the parent
(here, `VectorStore`), the FK becomes the thing standing between you and drop-in
parity. Dropping it is correct *if* you move the integrity responsibility
somewhere explicit and write down why. This repo does both — the comment is the
contract.

## Primary diagram

The full asymmetry: one cluster enforces, one doesn't, and why.

```
  Soft link vs hard link — the schema's two integrity contracts

  RETRIEVAL CLUSTER (soft)            TRAJECTORY CLUSTER (hard)
  ──────────────────────              ──────────────────────────
  documents.id                        conversations.id
       ▲                                   ▲
       ┊ document_id text                  ║ conversation_id uuid
       ┊ (NO FK — dropped :27)             ║ references ... (FK :42)
       ┊                                   ║ on delete cascade
  chunks ───────────                  messages ───────────
   ├ doc chunks  (doc_id set)          delete a conversation
   └ memory chunks (doc_id NULL) ←      → its messages cascade away
     enabled by the missing FK

  reason: chunks must be a drop-in VectorStore; messages need not be
```

## Elaborate

"Soft foreign key" / "logical foreign key" is a known pattern — common in
event-sourced systems, polyglot stores, and anywhere a table must be writable by
a component that doesn't own the parent. The cost is always the same: integrity
moves from the DB (declarative, total) to app code (imperative, partial). The
mitigation, when you can afford it, is a periodic reconciliation job that finds
orphans — chunks whose `document_id` has no matching document, or documents with
zero chunks. This repo doesn't have one yet; the honest `not yet exercised` note
in `audit.md` Lens 4 is exactly that gap. The deliberate FK *kept* (messages) is
the proof this wasn't laziness — when integrity didn't fight an interface, they
enforced it.

## Interview defense

**Q: You dropped a foreign key on purpose. Defend that.**

The `chunks` table has to be a drop-in implementation of an in-memory
`VectorStore` interface that has no concept of a `documents` row. A NOT-NULL FK
would force every chunk to have a pre-existing document — but conversation-memory
chunks have no document and never will. Dropping the FK is what lets one table
serve both populations. I kept the FK on `messages → conversations` because
nothing there fights an interface, which shows the drop was a decision, not
neglect.

```
  with FK:    can't insert memory chunk (doc_id NULL → rejected)
  without FK: doc chunks + memory chunks share one table
              integrity moves to app code (indexDocumentRow writes doc first)
```

Anchor: "the FK was the thing standing between `chunks` and drop-in parity — so
it's gone, and the integrity moved to documented app-code convention."

**Q: What did you give up, and how would you get it back if it mattered?**

I gave up DB-enforced referential integrity: orphan chunks and dangling
documents are now possible and the DB won't catch them. If it started mattering
I'd add a reconciliation query — `chunks left join documents` where the parent is
null and `kind != 'memory'` — run on a schedule, rather than re-adding the FK,
because re-adding it would break the memory chunks again.

## See also

- `07-non-atomic-document-chunk-write.md` — the same relationship from the
  transaction angle: the write that should keep doc + chunks together isn't atomic.
- `04-deterministic-chunk-ids.md` — the `"memory:<conv>:<n>"` ids the NULL-doc
  chunks carry.
- `audit.md` Lens 4 — integrity, DB-enforced vs app-enforced.

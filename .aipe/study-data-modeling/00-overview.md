# Overview — the data model of `buffr-laptop`

One page. The shape, the verdict, what's load-bearing.

---

## What this repo persists

`buffr-laptop` is the laptop brain of a self-hosted personal RAG agent. It
took an in-memory RAG pipeline and gave it a real Postgres home: database
`reindb`, schema `agents`, single-device, `pgvector` for the embeddings.
Everything durable lives in six tables defined in two migrations,
`sql/001_agents_schema.sql` and `sql/002_decision_journal.sql` (the latter
added the decision journal behind `/research` and `/review`).

```
  The six tables, by what they hold

  ┌──────────────┬───────────────────────────────────────────────┐
  │ documents    │ source-of-truth corpus rows (the markdown you  │
  │              │ indexed). One row per source doc.              │
  ├──────────────┼───────────────────────────────────────────────┤
  │ chunks       │ the workhorse. embedding vector(768) + content.│
  │              │ Holds BOTH retrieval chunks ("<docId>#<index>")│
  │              │ AND episodic memory ("memory:<conv>:<n>",      │
  │              │ tagged meta.kind='memory'). HNSW index.        │
  ├──────────────┼───────────────────────────────────────────────┤
  │ conversations│ one row per chat session.                      │
  ├──────────────┼───────────────────────────────────────────────┤
  │ messages     │ the full agent trajectory: every step, tool    │
  │              │ call, tool result, model_usage, warning, error.│
  ├──────────────┼───────────────────────────────────────────────┤
  │ profiles     │ the me.md-style user profile, one content blob.│
  ├──────────────┼───────────────────────────────────────────────┤
  │ decisions    │ the decision journal: one row per promoted     │
  │              │ /research prediction, tracked from open to     │
  │              │ resolved. No FK to anything, incl. no soft link.│
  └──────────────┴───────────────────────────────────────────────┘
```

Every table carries `app_id` (default `'laptop'`); `decisions` additionally
carries `user_id`/`workspace_id`, both collapsed to the same value as
`app_id` today. There is exactly **one** real foreign key in the whole
schema: `messages.conversation_id → conversations(id) on delete cascade`.
The chunks→documents link that you'd expect to be a foreign key is
**deliberately not one** — it's dropped on purpose (line 27). That single
decision is the most interesting thing in the original five-table schema,
and `03-soft-link-no-fk.md` walks why. `decisions` goes a step further and
has no link at all, soft or hard, to any other table.

---

## The verdict

The shape **matches the access pattern well** where it counts, and makes two
deliberate, defensible departures from textbook normalization:

1. **The dropped foreign key (`chunks.document_id`)** is the right call. The
   vector store (`PgVectorStore`) implements aptkit's `VectorStore` contract,
   which upserts chunks with no notion of a parent documents row. A hard
   foreign key would break drop-in parity with the in-memory store *and* would
   forbid memory chunks, which legitimately have no document. The cost — no
   database-enforced referential integrity for chunks — is accepted knowingly.
   `03-soft-link-no-fk.md`.

2. **Text stored twice** (`chunks.content` *and* `meta.text` inside the jsonb)
   is deliberate denormalization for read-path simplicity, not an accident.
   It's the one place a senior reviewer should push back, because both copies
   are independently writable. `05-text-stored-twice.md`.

What's genuinely good: the **trajectory tables** are fully populated — not just
assistant turns but tool args, durations, errors, and token counts, with
`created_at` driven by the event timestamp for deterministic replay order.
That's a richer message log than most production agents ship.
`06-trajectory-tables.md`.

**New this sync — `agents.decisions`, and it earns two more pattern files.**
The decision journal (`sql/002_decision_journal.sql`) pairs
`predicted_score`/`predicted_dimension`/`predicted_confidence` (the user's
blind guess) against `assessed_score`/`assessed_confidence` (the engine's
score, computed after) on one row. It looks like a third instance of
"text-stored-twice" at first glance — it isn't. The two column families are
different facts, not copies of one fact, and collapsing them would destroy
the reason the table exists. `07-predicted-vs-assessed-columns.md` walks the
test that tells the two patterns apart. Separately, the table's `status`
lifecycle (`open → review-due → resolved`) is advanced entirely as a side
effect of a *read* — `PgJournalStore.listDue` runs an `UPDATE` before its
`SELECT`, because nothing else in the codebase watches `review_at`. That's a
legitimate lazy-expiry pattern, not a bug, and it's the kind of thing that
looks alarming until you name it. `08-lazy-status-transition.md`.

The honest gap: the **document + chunk write is non-atomic** across two
transactions (`runtime.ts` writes the documents row, then `pipeline.index()`
writes the chunks in a *separate* transaction inside `PgVectorStore.upsert`).
A crash between them leaves a documents row with no chunks. `audit.md` §4
calls this out — and now has a sibling: `listDue`'s UPDATE-then-SELECT is
also two statements outside one transaction, safe here only because it's
idempotent.

---

## Worst-first ranking — what to look at, in order

```
  rank   finding                                where
  ────   ─────────────────────────────────────  ──────────────────────────
   1     non-atomic document+chunk write         audit.md §4, 03-soft-link
   2     text stored twice, both writable        05-text-stored-twice.md
   3     app_id (+ now user_id/workspace_id on   04-app-id-tenant-column.md
         decisions) is shape-only (no RLS, not   → study-security
         token-derived) — a security seam
   4     soft link = no referential integrity    03-soft-link-no-fk.md
         for chunks (deliberate, but real);
         decisions has no link at all, not
         even soft
   5     listDue's UPDATE-then-SELECT isn't      audit.md §4,
         one transaction (idempotent, low risk)  08-lazy-status-transition.md
   6     migration order is now explicit         audit.md §5
         (MIGRATION_FILES), but applied-state
         still isn't recorded anywhere
```

Not on the list, deliberately: `agents.decisions`'s predicted-vs-assessed
twin columns. It reads like a red flag on first pass and isn't one —
`07-predicted-vs-assessed-columns.md` is worth reading precisely because it
walks *why* it doesn't belong on this ranking.

None of these are bugs to panic over on a single-device personal tool. They're
the exact tradeoffs a staff reviewer would name in a design review, each with a
reason it was the right call at this phase.

---

## Where to go next

- `audit.md` — the systematic sweep across all 7 lenses, with honest
  "not yet exercised" for RLS, partitioning, soft-deletes, recorded migration
  state.
- The eight pattern files — each a deep walk of one load-bearing shape.
- `README.md` — the full schema diagram and the cross-links.

# Overview — what's interesting about this data model

One page. The verdict, then the five things worth opening a file for.

## The verdict

buffr-laptop persists a RAG agent into one Postgres instance (`reindb`,
schema `agents`). Five tables, one schema, one `vector(768)` column, one
HNSW index, one real foreign key. The model is small and honest — it does not
hide structure in a JSON blob, and it indexes the one hot path correctly.

What makes it worth studying is the **tension between a relational schema and
an external `VectorStore` contract**. aptkit's `VectorStore` interface
(`src/pg-vector-store.ts:38`) speaks only `{id, vector, meta}` — it has never
heard of a `documents` row. The schema bends in two visible places to honor
that contract, and both bends are the kind of decision you defend in an
interview.

Two things changed since the first pass and are now true of the live data:
(1) `chunks` holds a **second population** — episodic-memory rows
(`memory:<conv>:<n>`, `meta.kind='memory'`, `document_id=null`) written by
`@aptkit/memory` through the same store (`src/session.ts:53,67`); this is the
dropped FK earning its keep. (2) The trajectory table is now **fully written** —
the fixed trace sink populates `tool_calls`/`tool_results`/`model`/`tokens_used`
and sets `created_at` from the event timestamp (previously those columns sat
null). The driver is now `npm run chat` (a long-lived session), not the
deleted one-shot `ask` CLI.

## The map: which axis flips where

Trace one axis — *who guarantees this fact is correct?* — across the schema,
and watch the answer flip at the seams.

```
  axis traced: "who enforces correctness here?"

  ┌─ messages → conversations ──────────────────────┐
  │  the DATABASE (FK + on delete cascade)           │  ← strongest
  └──────────────────────────────────────────────────┘
                       seam: FK present vs FK dropped
  ┌─ chunks → documents ────────────────────────────┐
  │  NOBODY (soft link, FK explicitly dropped :27)   │  ← weakest
  └──────────────────────────────────────────────────┘
                       seam: column vs auth boundary
  ┌─ app_id tenant isolation ───────────────────────┐
  │  the APP, if it remembers `where app_id=$2`      │  ← hopeful
  │  (no RLS, not token-derived)                      │
  └──────────────────────────────────────────────────┘
                       seam: one column vs two stores
  ┌─ chunk text correctness ────────────────────────┐
  │  NOBODY — stored in content AND meta.text,        │  ← redundant
  │  nothing keeps them equal                          │
  └──────────────────────────────────────────────────┘
```

Same schema, four different answers to "who keeps this true." That spread —
from a real cascade FK down to no enforcement at all — is the lesson.

## The five (six) things worth a file

1. **`01-vector-column-and-ann-index`** — the `vector(768)` column + HNSW
   `vector_cosine_ops`. This is the load-bearing structure: it turns a
   full-table distance scan into a graph walk. The pattern that makes the app
   a RAG app.

2. **`02-text-stored-twice`** — chunk text in `chunks.content` *and* inside
   `chunks.meta` jsonb. The worst normalization finding, and a deliberate one.
   The DB analog of information leakage.

3. **`03-deterministic-chunk-ids`** — `id = "<docId>#<index>"`. The id
   *encodes* its identity, which is what makes the `on conflict (id) do
   update` re-indexing idempotent with no `unique(document_id, chunk_index)`.

4. **`04-soft-link-no-fk`** — `chunks.document_id` with the FK explicitly
   dropped for `VectorStore` drop-in parity. The schema bending to a
   document-store contract.

5. **`05-app-id-tenant-column`** — `app_id` on every table. Multi-tenant in
   shape only: no RLS, not token-derived. The future seam, not a current
   boundary.

6. **`06-trajectory-tables`** — conversations/messages, append-only event
   capture across a chat session, and the one genuine FK with `on delete
   cascade`. The counter-example to the soft link: here the schema *does*
   enforce integrity. Now also the place to see a *fully populated* event log —
   all six `CapabilityEvent` types written, `tool_calls`/`tool_results`/`model`/
   `tokens_used` filled, `created_at` from the event timestamp.

Start with `audit.md` for the full lens sweep; come here for the shortlist;
open the numbered files for the deep walks.

---
Updated: 2026-06-24 — `chunks` now has a second (memory) population; trajectory
columns now populated by the fixed trace sink; driver is `npm run chat` not the
deleted `ask` CLI.

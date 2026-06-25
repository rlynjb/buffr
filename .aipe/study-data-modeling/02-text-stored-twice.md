# Text Stored Twice (content + meta.text)

**Industry names:** denormalization / jsonb sidecar / data duplication.
**Type:** Project-specific (a deliberate normalization compromise).

## Zoom out, then zoom in

Here's a single `chunks` row, and the fact that lives in it twice.

```
  Zoom out — where the duplication lives

  ┌─ Storage layer — one agents.chunks row ─────────────┐
  │                                                      │
  │   content  text   ──►  "the chunk's text..."         │ ★ copy A
  │   meta     jsonb  ──►  { text: "the chunk's text...",│ ★ copy B
  │                          docId: "...",               │
  │                          chunkIndex: 3 }             │
  │   embedding vector(768)                              │
  │                                                      │
  │   nothing in the schema keeps copy A == copy B       │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** The same chunk string is in the `content` column **and** inside
the `meta` jsonb of the same row. This is the DB analog of information
leakage — one fact, two homes, no single source of truth. The question:
*why is it there twice, and what breaks because of it?*

## The structure pass

**Layers:** (1) the relational column `content` — what SQL reads directly.
(2) the schemaless `meta` jsonb — the opaque aptkit payload, which *contains*
`text`. Two representations of one string at two altitudes of the same row.

**Axis — source of truth:** trace "which copy is authoritative?" across the
two. On write, `content` is *derived from* `meta.text`
(`src/pg-vector-store.ts:46`) — so `meta` is upstream. On read, `meta.text`
is *reconstructed from* `content` (`:83`) — so `content` is upstream. The
authority flips depending on direction. That's the smell: neither is
canonical.

**Seam:** the load-bearing boundary is **the `VectorStore` contract**. Above
it, aptkit hands you an opaque `meta` object it owns and will read back
verbatim. Below it, your SQL wants a plain text column it can `select`
without parsing jsonb. The duplication lives exactly at that seam — it's the
price of satisfying both sides.

## How it works

### Move 1 — the mental model

You know how you sometimes denormalize a `user_name` onto an `orders` row so
a list query doesn't join `users`? Same move here — `content` is a
denormalized copy of `meta.text` so SQL reads text without cracking open
jsonb. The difference: denormalizing across *tables* is a known read
optimization; duplicating *within one row* buys almost nothing and still
carries the full consistency risk.

```
  one fact, two homes — the write/read round-trip

  WRITE:   c.meta.text  ──derive──►  content column
              (upstream)             (copy)
                  │                     │
                  └── both written to the same row ──┐
                                                     ▼
  READ:    content column ──reconstruct──►  meta.text
              (now upstream)                (rebuilt copy)

  the authority flips by direction → no single source of truth
```

### Move 2 — the step-by-step walkthrough

**On write — `content` is carved out of `meta`.** The upsert reads
`c.meta.text` and assigns it to a local `content`, then writes *both* the
`content` column and the whole `c.meta` jsonb into the row. So `meta.text`
and `content` enter the row as the same string, by construction. They agree
at write time — the risk is purely future drift.

**On read — `meta.text` is rebuilt from `content`.** The search SELECTs the
`content` column, then reconstructs the in-memory `meta` shape by spreading
the stored `meta` jsonb and *overwriting* `text` with the freshly-read
`content`. So a reader always sees `meta.text === content` even if the stored
jsonb's `text` had drifted — the read silently papers over any divergence.

**Where it breaks.** Picture a future migration that lowercases
`chunks.content` for case-insensitive display but doesn't touch `meta`. Now
the row holds two different truths: `content` (lowercased) and `meta.text`
(original). The read path masks it (it overwrites `meta.text` with `content`),
but any SQL that reads `meta->>'text'` directly — an analytics query, a
backfill, a different consumer — gets the stale copy. Nothing in the schema
(no generated column, no trigger, no check) keeps them equal.

### Move 2.5 — current state vs the fix

```
  Phase A (now)              Phase B (the fix, if it bites)
  ─────────────              ──────────────────────────────
  content: text col         content: text col  (the one truth)
  meta:    jsonb WITH text   meta:    jsonb WITHOUT text
                             read path injects text from content
                             on the way out (already does this!)

  cost of the fix: drop `text` from the meta written at
  pg-vector-store.ts:55 BEFORE storing; the read at :83 already
  rebuilds meta.text from content, so consumers see no change.
```

The striking part: the read path *already* reconstructs `meta.text` from
`content` (`:83`). So `meta.text` doesn't *need* to be stored at all — the
column is enough. The duplication is removable today with no consumer change.

### Move 3 — the principle

Normalization is information-hiding for data: one fact, one place, one writer.
The moment a fact has two homes with no mechanism keeping them equal, you've
re-introduced exactly the bug that normalization exists to prevent — an
update that touches one copy and forgets the other. Denormalize on purpose,
across tables, for a measured read win — not by accident, within a row, for
nothing.

## Primary diagram

```
  the duplication, write and read, one row

  ┌─ aptkit (owns meta) ─────────────────────────────────┐
  │  c.meta = { text, docId, chunkIndex }                 │
  └───────────────────┬───────────────────────────────────┘
            write       │  content := c.meta.text  (derive)
  ┌─ Postgres row ─────▼───────────────────────────────────┐
  │  content  = "text..."   ◄── copy A                      │
  │  meta     = {text:"text...", ...}  ◄── copy B (verbatim)│
  └───────────────────┬───────────────────────────────────┘
            read        │  meta.text := content  (reconstruct, overwrite)
  ┌─ back to aptkit ───▼───────────────────────────────────┐
  │  { ...meta, text: content }  → citations               │
  └─────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Triggered on every index (`npm run index`) and every search
(`npm run chat`). Indexing writes the duplication; searching reads `content`
and rebuilds `meta.text` so aptkit's `search_knowledge_base` citations have
the text to quote. It also fires on every **memory write**: `createConversationMemory`
upserts each exchange through the *same* `PgVectorStore`
(`src/session.ts:53,67`), and `@aptkit/memory` itself sets `meta.text` to the
formatted exchange (`conversation-memory.ts:84`) — which the upsert then
derives `content` from (`pg-vector-store.ts:46`). So the redundancy holds
identically for `memory:<conv>:<n>` rows: the exchange text lives in `content`
and in `meta.text` of the same row, library-set on one side, column-derived on
the other.

**Write side — `src/pg-vector-store.ts:46,55`:**

```
  const content = typeof c.meta.text === 'string' ? c.meta.text : '';
        │                    │
        │                    └─ meta.text is the upstream source here
        └─ content column is a DERIVED copy

  ...values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
                            │                    │
                            │ ($5 = content)     └─ $8 = c.meta — the WHOLE
                            └─ copy A written        jsonb, incl. text = copy B
```

**Read side — `src/pg-vector-store.ts:71,83`:**

```
  select id, content, chunk_index, document_id, meta, ...   ← reads BOTH

  meta: { ...(r.meta ?? {}), docId: r.document_id,
          chunkIndex: r.chunk_index, text: r.content }
                                            │
                                            └─ meta.text OVERWRITTEN with the
                                               content column — proves the
                                               stored meta.text is redundant
```

**Secondary instances — same row, smaller payloads:** `chunk_index` is a
column (`sql/001_agents_schema.sql:21`) *and* `meta.chunkIndex`
(`pg-vector-store.ts:45`); `document_id` is a column (`:16`) *and*
`meta.docId` (`pg-vector-store.ts:44`). Same sidecar-redundancy shape.

## Elaborate

This is the classic jsonb-sidecar tension: you keep a schemaless blob for
flexibility (aptkit's `meta` can carry fields you didn't model), but you
promote a few hot fields to real columns for SQL access and indexing. The
mistake here isn't promoting `text` to a column — that's correct, SQL needs
it. The mistake is leaving the original copy *inside* `meta` after promoting
it. The clean pattern: promote to column, strip from blob, re-inject on read
if the consumer's contract expects it there. Cross-link
`study-software-design` → information-hiding: same single-source-of-truth
principle, applied to data instead of code.

## Interview defense

**Q: Your `chunks` table stores the chunk text in both `content` and
`meta.text`. Defend it.**

```
  content (column)  ◄── SQL reads this directly, indexes, citations
  meta.text (jsonb) ◄── aptkit's opaque payload, written verbatim
                        BUT read path overwrites it from content anyway
```
Answer, honest: it's a real redundancy, not a feature. `content` exists
because SQL shouldn't parse jsonb to read text — that's the right call. But
leaving `text` *inside* `meta` after promoting it to a column is the bug:
two copies, nothing keeps them equal. The tell is that my read path already
rebuilds `meta.text` from `content` (`pg-vector-store.ts:83`), so the stored
copy is dead weight. The fix is one line — strip `text` from `meta` before
the insert at `:55`. **Anchor:** the read already reconstructs it, so the
column is the only source I actually need.

## Validate

1. **Reconstruct:** draw the write-derive / read-reconstruct round-trip.
2. **Explain:** why does the search result look consistent even if the stored
   `meta.text` drifted from `content`? (`pg-vector-store.ts:83`)
3. **Apply:** you add a SQL job that reads `meta->>'text'` for analytics.
   What breaks after a `content`-only migration, and why?
4. **Defend:** is denormalization ever right here? Where (across tables) vs
   where it's wrong (within this row)?

## See also

- `01-vector-column-and-ann-index.md` — why `content` rides in the SELECT.
- `03-deterministic-chunk-ids.md` — the other column/`meta` redundancy pair.
- `audit.md` §2 — normalization-and-duplication, the worst finding.
- `study-software-design` → information-hiding (the code analog).

---
Updated: 2026-06-24 — re-verified the duplication still holds for memory rows
written via `@aptkit/memory` (it sets `meta.text` at `conversation-memory.ts:84`;
buffr derives `content` from it); added the memory-write use case; `ask` → `chat`.

# Stale Embeddings

### *industry: embedding freshness / staleness tracking · type: the consistency gap between a document and its vectors*

## Zoom out

Every other file assumes the vectors are *current*. This one questions that. A chunk's embedding is a snapshot of the document text *at index time*. Edit the document and the vector doesn't move on its own — it now describes text that no longer exists. buffr has no mechanism to notice.

**buffr's retrieval stack, the freshness gap marked**

```
┌──────────────────────────────────────────────────────────────┐
│  search_knowledge_base  returns chunks (assumes fresh)         │
├──────────────────────────────────────────────────────────────┤
│  agents.chunks          embedding = snapshot at index time     │
├──────────────────────────────────────────────────────────────┤
│  ★ FRESHNESS ★          is the vector still the doc's truth?   │  ◄── this file
│                         NO staleness tracking in buffr         │
├──────────────────────────────────────────────────────────────┤
│  documents              content can change AFTER indexing      │
└──────────────────────────────────────────────────────────────┘
```

You probably hit this on your last RAG app and patched it by "just re-run the indexer." That works until the corpus is big enough that re-indexing everything is wasteful and you need to know *which* docs drifted. This file is about that gap — and it's a real, present risk in buffr, not a hypothetical.

## Structure pass

The axis is **time**: the document at index-time vs. the document now. The seam is the edit that happens *after* indexing and before the next re-index.

**The drift window**

```
   index time                  edit                    query time
   ──────────                  ────                    ──────────
   doc v1 ──► chunk ──► embed   doc v1 → doc v2         search hits the
   ┌──────────────┐            (content changes)        v1 embedding
   │ vector(v1)   │  ════════════ DRIFT WINDOW ════════►  for v2 text
   └──────────────┘            │                          │
        the vector             stale: describes v1,        answer cites
        is correct             but doc is now v2            text that's gone
```

Before the edit: the vector faithfully represents the document. After the edit, until the next re-index: the vector is a lie — it describes text that's been changed or deleted. Consequence: buffr can confidently retrieve and *cite* a passage that no longer exists in the source document, with no signal that anything is wrong.

## How it works

### Move 1 — Mental model: a cache with no invalidation

The vector is a cache of the document's meaning. Every cache has the same hard problem: invalidation. Edit the source, and the cache is stale until something refreshes it. buffr's cache has *no invalidation signal at all* — nothing marks a vector dirty when its document changes.

**Vector-as-cache, no invalidation**

```
  documents.content (source of truth)
        │  cached as
        ▼
  agents.chunks.embedding (the cache)
        │
   edit the doc ──► cache is now STALE
        │
        ▼
   nothing marks it dirty, nothing triggers refresh
   only a MANUAL `npm run index` rebuilds it
```

Frontend bridge: it's a memoized selector whose dependency changed but whose cache key didn't — you keep serving the old computed value because nothing told the memo to recompute. The fix in both worlds is a freshness signal (a dependency, a dirty flag, a timestamp) that says "recompute."

### Move 2 — Walk the mechanism

**Part A — Re-indexing replaces vectors, but only when you run it**

buffr's upsert *does* correctly overwrite a doc's chunks when you re-index — by id, idempotently. The gap isn't the overwrite; it's that nothing *triggers* the overwrite. It's manual.

**Refresh is correct but manual**

```
  npm run index -- work.md     ◄── YOU must run this after editing work.md
        │
        ▼ indexDocumentRow: upsert documents row, re-chunk, re-embed
        ▼ store.upsert: insert … on conflict (id) do update
  agents.chunks updated         ◄── vectors now fresh again
        ▲
   but until you run it, the old vectors stand
```

```ts
// src/runtime.ts:11-17 — re-index overwrites content + re-runs the pipeline
await pool.query(
  `insert into agents.documents (…) values (…)
   on conflict (id) do update set content = excluded.content, …`, …);
await pipeline.index({ id: doc.id, text: doc.text });   // re-chunk, re-embed, upsert
```

The mechanism is sound: re-running `npm run index` on an edited file replaces its chunks cleanly (chunk ids are `"<docId>#<i>"`, stable across re-index, so `on conflict` updates in place). The *risk* is entirely about the trigger: there is no scheduler, no file-watcher, no dirty flag. A doc edited a month ago still serves month-old vectors until a human remembers to re-index it.

**Part B — There is no `embedding_stale_at`, and no way to find drifted docs**

The schema records *when* a document was created (`documents.created_at`) but never *when its chunks were embedded* or *whether the content changed since*. So you cannot query "which docs are stale."

**What the schema can and can't tell you**

```
  documents:  id · content · created_at        ◄── created, but not "edited since embed"
  chunks:     id · content · embedding · …      ◄── NO embedded_at, NO stale flag
                                                     NO content-hash to compare

  CAN ask:  what's indexed?
  CANNOT ask: which indexed docs no longer match their source? ← the gap
```

```sql
-- sql/001_agents_schema.sql:4-25 — note what's absent
create table if not exists agents.documents (
  id text primary key, …, content text not null,
  created_at timestamptz not null default now()      -- created, not "fresh-as-of"
);
create table if not exists agents.chunks (
  …, content text not null, embedding vector(768) not null,
  embedding_model text …, meta jsonb …               -- NO embedding_stale_at,
);                                                    --  NO content_hash
```

The absent columns are the whole story. Without an `embedding_stale_at` (or a content hash to compare source-vs-indexed), staleness is *undetectable* — buffr can't even report the problem, let alone fix it. The risk is real and silent.

### Move 2.5 — Current vs. future

**Case B: buffr has no staleness tracking. Re-index is manual and undetectable-when-needed.**

```
  TODAY                              STALENESS TRACKING (the gap)
  ─────                              ───────────────────────────
  manual `npm run index`             ① store content_hash at index time
  no signal a doc drifted            ② on doc edit ──► mark embedding_stale_at
  silent: vector ≠ source            ③ background/idle job re-embeds stale docs
  ┌──────────────────┐               ┌──────────────────────────────┐
  │ overwrite works, │               │ detect drift ──► auto-refresh │
  │ trigger doesn't  │               └──────────────────────────────┘
  └──────────────────┘                stale vectors become visible + fixable
```

The fix is two parts: *detection* (a content hash or a `stale_at` timestamp set on edit) and *refresh* (an idle/background job that re-embeds whatever's marked stale). buffr has the refresh *primitive* (idempotent upsert) but neither the detection nor the trigger.

### Move 3 — The principle

**An embedding is a cache, and an un-invalidated cache eventually lies.** The dangerous part of stale embeddings isn't that vectors go out of date — all caches do — it's that buffr can serve a confident, *cited* answer from a vector whose source text is gone, with no signal of wrongness. Silent staleness is worse than a missing answer. The honest state: buffr's refresh is correct but manual and undetectable-when-stale. Making freshness *visible* (a timestamp, a hash) is the prerequisite to making it automatic.

## Primary diagram

The drift window and the tracking that would close it.

**From edit to stale answer, and where detection belongs**

```
  doc v1 ──► index ──► vector(v1)        [content_hash stored?  NO]
                          │
  EDIT doc v1 → v2 ───────┼──────────────────────────────────────
                          │   ★ no signal fires (no stale_at)      ★
                          ▼
  query ──► search ──► returns vector(v1) ──► cites v1 text
                          │
                          ▼
  answer grounded in text that no longer exists  ◄── silent failure
  ───────────────────────────────────────────────────────────────
  FIX: hash content at index; on edit set embedding_stale_at;
       idle job re-embeds stale docs (refresh primitive already exists)
```

After the box: the upsert that would refresh the vector already works — the entire gap is *knowing which vectors need it*.

## Elaborate

- **buffr's corpus hides the risk.** The eval docs are static files you index once. A live corpus — notes you edit, a synced folder, an app DB — drifts constantly, and that's where silent staleness bites. The risk scales with edit frequency.
- **Detection is cheap; a content hash is enough.** Store a hash of each doc's content at index time. On the next index pass (or an edit hook), compare; if the hash differs, the vector is stale. That's a single column and a comparison — far cheaper than re-embedding to check.
- **`embedding_model` is already a staleness axis.** The column records which model embedded each chunk. A model upgrade makes *every* vector stale in a different sense (file 02's one-way door). Same column, two freshness questions: stale content, stale model.
- **Refresh should be idle, not in-path.** Re-embedding is expensive; you don't do it on the query path. A background or idle-time job that drains the `stale_at` queue keeps queries fast while keeping vectors converging toward fresh.

## Project exercises

### Add content-hash staleness detection

- **Exercise ID:** [B2B.10] (cite [C2.8], Phase 2B) — Case B: buffr has **no staleness tracking**. This is the primary target (the detection half).
- **What to build:** Store a `content_hash` (and/or `embedded_at`) per document at index time. On re-index, compare the source hash to the stored one and report which docs drifted *before* re-embedding them. Add an `embedding_stale_at` column set when a doc's content changes.
- **Why it earns its place:** Staleness is currently *undetectable* — the schema can't answer "which docs drifted." This makes the silent risk visible, which is the prerequisite for any automated fix.
- **Files to touch:** `sql/001_agents_schema.sql` (add `content_hash` / `embedding_stale_at`), `src/runtime.ts` (compute + compare on `indexDocumentRow`).
- **Done when:** Editing a doc and re-running index reports it as stale-before-refresh, and you can query the set of stale documents.
- **Estimated effort:** 1 day.

### Add an idle re-embed job that drains the stale set

- **Exercise ID:** [B2B.11] (cite [C2.8], Phase 2B) — Case B: the refresh-trigger half (depends on [B2B.10]).
- **What to build:** A background/idle command that finds documents with `embedding_stale_at` set, re-chunks and re-embeds them via the existing pipeline, and clears the flag — off the query path.
- **Why it earns its place:** Detection without refresh just surfaces the problem; this closes the loop using buffr's existing idempotent upsert as the refresh primitive. Keeps queries fast while vectors converge to fresh.
- **Files to touch:** a new CLI command reusing `indexDocumentRow`/`pipeline.index` (`src/runtime.ts`, `src/cli/`), clearing `embedding_stale_at` after success.
- **Done when:** Marking docs stale then running the job re-embeds exactly those docs and clears the flags, with queries unaffected during the run.
- **Estimated effort:** 1–2 days (after [B2B.10]).

## Interview defense

**Q: "What's the stale-embeddings risk in buffr?"**

A chunk's embedding is a snapshot of the doc at index time. Edit the doc and the vector still describes the old text — but buffr has no `embedding_stale_at`, no content hash, so it can't even detect the drift. It can serve and cite a passage that no longer exists. Re-index fixes it, but only manually.

```
  edit doc ──► vector describes old text ──► no signal ──► cites gone text
```

Anchor: *"An embedding is an un-invalidated cache."*

**Q: "Is the re-index mechanism itself broken?"**

No — the upsert overwrites a doc's chunks idempotently by id, so re-running index refreshes correctly. The gap is the *trigger* and *detection*: nothing marks a doc dirty on edit, and the schema can't list stale docs. Fix is a content hash plus an idle re-embed job.

```
  refresh: correct (idempotent upsert)
  trigger + detection: missing
```

Anchor: *"The overwrite works; knowing when to overwrite doesn't."*

## See also

- `./10-incremental-indexing.md` — the sibling gap: detecting *which* docs changed, and handling deletes.
- `./02-embedding-model-choice.md` — model-staleness, the other axis the `embedding_model` column tracks.
- `./04-vector-databases.md` — the idempotent `on conflict` upsert that is the refresh primitive.
- `../../study-database-systems/` — cache invalidation, content hashing, change-data-capture patterns.

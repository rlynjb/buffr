# Stale embeddings — text changed, vector didn't (untracked)

*Industry standard (NOT yet tracked). The freshness gap buffr can fix but can't detect.*

## Zoom out, then zoom in

Pull up the storage layer and ask a question buffr can't currently answer: *is this embedding still in sync with its source text?* A chunk's `embedding` is derived from its `content` at index time. If the source changes but you don't re-index, the vector now describes *old* text — it's stale. buffr has no column, no flag, no timestamp tracking this.

```
  Zoom out — the freshness signal buffr doesn't store

  ┌─ Source of truth ───────────────────────────────────────────┐
  │  agents.documents.content   (or the file on disk)            │
  └───────────────────────────┬─────────────────────────────────┘
                              │ derived at index time
  ┌─ Storage ─────────────────▼─────────────────────────────────┐
  │  agents.chunks.embedding (768)  +  content                  │
  │  ★ NO embedding_stale_at / no dirty flag (MISSING) ★         │ ← here
  │  → can't tell which embeddings drifted from their source     │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. You know the cache-invalidation problem — derived data goes stale when its source changes, and the hard part isn't *recomputing*, it's *knowing when to*. An embedding is a cache of meaning over text. buffr can *fix* staleness (re-index overwrites via `on conflict do update`), but it has no way to *detect* that a re-index is due. This file builds the staleness problem, shows buffr's partial mitigation (upsert), and names the gap: no `embedding_stale_at`, no detection. Case B adds the tracking.

## Structure pass

Read the skeleton: a derived value, its source, and the missing link between them.

**Layers:** source text → derived embedding. The arrow only flows one way, and nothing watches it.

**Axis traced — "how does a change in source reach the embedding?"**

```
  one axis: how does source-change propagate to the vector?

  ┌─ source (content) ──────┐   MUTABLE — edit the file / documents row
  │  agents.documents.content│   any time; nothing fires on change
  └────────────┬────────────┘
               │ seam: NO change-detection, NO staleness column
  ┌─ derived (embedding) ───┐   FROZEN AT INDEX TIME — only a manual
  │  agents.chunks.embedding │   re-index updates it; until then, stale
  └─────────────────────────┘
```

**The seam that matters:** the source→derived boundary, where a change *should* trigger a re-embed but nothing does. The embedding is computed once and never told its source moved. buffr's only mitigation lives on the *fix* side, not the *detect* side: `on conflict do update` means *when* you re-index, staleness is cleanly overwritten — but nothing tells you *when* that is. Hold that: buffr can repair staleness but is blind to it.

## How it works

### Move 1 — the mental model

You know the two hard problems joke — cache invalidation is one of them. An embedding is a cache: an expensive-to-compute derived value (meaning) over a source (text). The easy part is recomputing it. The hard part is *knowing it's stale* — that the source changed since you last computed. buffr has the recompute (re-index) but not the staleness signal.

```
  the staleness kernel — derived value drifts from its source

  t0:  content = "renew by mail"   ──embed──►  vector_A   (in sync ✓)
  t1:  content edited to "renew online"        vector_A   (STALE ✗)
                                               └ still describes "by mail"
  t2:  re-index ──► vector_B (in sync ✓)   ← upsert fixes it... IF you run it
       └ but NOTHING at t1 flagged that t2 was needed
```

The kernel: a derived value + its source + a *freshness signal* linking them. buffr has the first two. The missing third — "is this still fresh?" — is the whole gap.

### Move 2 — the step-by-step walkthrough

**Step 1 — the mitigation buffr HAS: re-index overwrites cleanly.** When you do re-index, staleness is repaired because the upsert overwrites the embedding in place under the same chunk id:

```ts
// src/pg-vector-store.ts:50-54
on conflict (id) do update set
  ..., content = excluded.content,
  embedding = excluded.embedding, ...     -- new content AND new vector, atomically
```

So there's no *duplicate* stale vector, no orphaned old embedding for an edited chunk — a re-index makes `content` and `embedding` consistent again. That's the partial mitigation: the *fix* is clean. (The shrink-orphan exception from `10-incremental-indexing.md` still applies — chunks that vanish aren't deleted.)

**Step 2 — the gap buffr HAS: no detection.** Look at the chunks schema. There's no timestamp, no hash, no flag tying the embedding to a version of its source:

```sql
-- sql/001_agents_schema.sql:14-25 — what's NOT here
create table if not exists agents.chunks (
  id text primary key,
  ...
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
  -- ⚠ NO embedding_stale_at, NO content_hash, NO indexed_at
);
```

Without any of those, there is no query you can run to answer "which embeddings are out of date?" The information simply isn't recorded. You'd only discover staleness by noticing a *wrong retrieval* — far too late, and indistinguishable from other retrieval bugs.

```
  Comparison — fix side vs detect side

  ┌─ FIX (buffr HAS) ────────┐    ┌─ DETECT (buffr LACKS) ─────┐
  │ on conflict do update     │    │ embedding_stale_at column   │
  │ re-index overwrites clean │    │ content_hash to compare     │
  │ no duplicate stale vector │    │ a query: "which are stale?" │
  └───────────────────────────┘    └────────────────────────────┘
  buffr can repair staleness; it cannot SEE it
```

**Step 3 — the Case-B move: track freshness.** Add an `embedding_stale_at` (or a `content_hash` + `indexed_at`) to the chunks/documents rows. On a source edit, mark stale; on re-index, clear it. Now staleness is a *query*, not a guess:

```
  // staleness tracking (the Case-B addition)
  on source edit (documents.content changes):
      set documents.embedding_stale_at = now()     // flag it dirty
  on re-index:
      ... existing upsert (content + embedding) ...
      set documents.embedding_stale_at = null       // clear the flag
  // now you can ASK:
  select id from agents.documents where embedding_stale_at is not null
```

```
  Layers-and-hops — adding the freshness signal

  ┌─ edit ───────┐ hop 1: content changes       ┌─ agents.documents ──┐
  │ file/row edit│ ─────────────────────────────►│ set stale_at=now()  │
  └──────────────┘                                │ (NEW column)        │
  ┌─ reindex ────┐ hop 2: upsert + clear flag     │                     │
  │ npm run index│ ─────────────────────────────►│ embedding refreshed │
  └──────────────┘                                │ stale_at = null     │
                                                  └─────────────────────┘
  hop 3: a query lists stale docs → a re-index job knows what to do
```

**Step 4 — the boundary condition: detection without a watcher is half a fix.** A `stale_at` column only flips if *something writes to it on edit*. If edits happen outside buffr (you edit the markdown file directly), buffr never sees the change to flag it — so detection also needs either a file-watcher/`mtime` check or a content-hash compared on every re-index. The honest version: a hash on the documents row, recomputed at index time, is the most robust detector because it needs no live watcher.

### Move 3 — the principle

Derived data is a cache, and a cache without an invalidation signal silently serves stale answers. The expensive part of embeddings isn't recomputing them — it's knowing *when* to. buffr solved the cheap half (clean overwrite) and skipped the hard half (detection), which is the classic shape of the cache-invalidation trap. The general lesson: whenever you store a value derived from a mutable source, store *something* that lets you tell whether the two still agree — a timestamp, a hash, a version — or you've built a cache you can never trust.

## Primary diagram

The staleness gap, one frame:

```
  stale embeddings — buffr can fix, can't detect

  documents.content (mutable source)
     │ derived at index time
     ▼
  chunks.embedding (768)  ── frozen until re-indexed ──
     │
     ├─ FIX (HAS):  re-index → on conflict do update → clean overwrite
     │
     └─ DETECT (MISSING): no embedding_stale_at / content_hash / indexed_at
                          → no way to ASK "which embeddings drifted?"
  ───────────────────────────────────────────────────────────
  Case B: add content_hash (+ stale_at); flag on edit, clear on reindex
          → staleness becomes a query, not a guess
```

## Elaborate

Embedding staleness is a specific instance of the materialized-view / cache-invalidation problem: any precomputed value over changing source data drifts unless something tracks the relationship. In a vector store it's especially insidious because a stale embedding doesn't error — it just quietly returns the *old* meaning, so a query about updated content matches against text that no longer exists. You find out via a wrong answer, which is the worst feedback loop.

The robust detector is a content hash stored alongside the source (e.g. on `agents.documents`): at index time, compare the new file's hash to the stored one — if different, re-embed and update the hash; if same, skip. That single column buys you both staleness *detection* and the change-detection that `10-incremental-indexing.md` wants for skipping unchanged files — they're the same mechanism viewed from two angles. A `stale_at` timestamp is a lighter alternative but only works if every edit path writes to it, which fails when files are edited outside buffr. Hash-on-reindex is the version that doesn't rely on a watcher.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Add staleness detection via content hash

- **Exercise ID:** STL-1 (Case B — buffr can't detect staleness; add tracking).
- **What to build:** add a `content_hash` (and optional `embedding_stale_at`) column to `agents.documents`; compute the hash at index time; expose a query/command that lists documents whose on-disk content hash no longer matches the stored hash — the stale set.
- **Why it earns its place:** it converts staleness from an invisible bug into a queryable fact, and the same hash powers the unchanged-file skip in `10`.
- **Files to touch:** `sql/001_agents_schema.sql:4-12` (add column to `agents.documents`), `src/runtime.ts:11-17` (compute/compare hash in `indexDocumentRow`), new `src/cli/stale-cmd.ts` listing stale docs.
- **Done when:** editing a file and re-running the check lists it as stale until re-indexed; re-indexing clears it.
- **Estimated effort:** half a day.

### A re-index-stale command

- **Exercise ID:** STL-2 (Case B — close the loop from detect to fix).
- **What to build:** a `npm run reindex:stale` that finds all stale documents (via STL-1) and re-indexes only those — so the freshness signal drives an action, not just a report.
- **Why it earns its place:** detection is only useful if it triggers the cheap, targeted fix; this wires the loop end to end.
- **Files to touch:** new `src/cli/reindex-stale-cmd.ts`, reusing `indexDocumentRow` (`src/runtime.ts:5-18`) over the stale set from STL-1.
- **Done when:** running it re-embeds exactly the stale documents and leaves fresh ones untouched (no embedding calls for them).
- **Estimated effort:** 1–4hr. Cross-link `10-incremental-indexing.md`.

## Interview defense

**Q: How does buffr handle stale embeddings?**
Answer: it *fixes* them but can't *detect* them. Re-indexing overwrites cleanly — `on conflict (id) do update` replaces both `content` and `embedding` atomically, so there's no duplicate or orphaned stale vector for an edited chunk. But there's no `embedding_stale_at`, no `content_hash`, no `indexed_at` on the chunks or documents — so there's no way to ask "which embeddings drifted from their source?" You'd only notice staleness via a wrong retrieval, which is far too late.

```
  FIX (has):    re-index → overwrite content+embedding atomically
  DETECT (lacks): no stale_at / hash → can't query "which are stale?"
  → buffr repairs staleness but is blind to it
```

**Q: What's the most robust way to detect it, and why not just a timestamp?**
Answer: a content hash stored on the documents row, recomputed and compared at index time — different hash means re-embed, same means skip. A `stale_at` timestamp only works if *every* edit path writes to it, which fails when files are edited outside buffr (no watcher fires). A hash needs no live watcher; it's checked on the next index pass, and it doubles as the change-detection that lets you skip unchanged files. The anchor: **the load-bearing fact people forget is that an embedding is a cache — the hard part is knowing when to recompute, not the recompute itself.**

```
  content_hash on documents → compare at index time
  differs → re-embed + update hash ; same → skip
  (also powers the unchanged-file skip in 10)
```

## See also

- `10-incremental-indexing.md` — the same content-hash powers unchanged-file skipping (the other face of this gap).
- `02-embedding-model-choice.md` — `documents.content` as the source the hash guards.
- `04-vector-databases.md` — the `on conflict do update` upsert that cleanly repairs staleness.
- `../05-evals-and-observability/` — staleness surfaces as a retrieval-quality regression.

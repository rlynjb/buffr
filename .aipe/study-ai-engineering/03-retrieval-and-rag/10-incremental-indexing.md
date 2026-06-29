# Incremental indexing — per-file upsert, not full rebuild

*Industry standard (partially exercised). How buffr writes to the index today, and what it doesn't yet track.*

## Zoom out, then zoom in

Pull up the *write* side of RAG — the offline path nobody sees but everything depends on. Retrieval is only as fresh as the last index run. The question this file answers: when a file changes, do you rebuild the whole index, or surgically update just the affected vectors? buffr does the second, per file.

```
  Zoom out — where indexing sits (the write side)

  ┌─ CLI ───────────────────────────────────────────────────────┐
  │  npm run index -- file.md   (offline, manual, per-file)      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ readFile + per-file loop
  ┌─ Runtime ─────────────────▼─────────────────────────────────┐
  │  ★ indexDocumentRow: write documents row, then pipeline.index ★│ ← here
  └──────────────┬───────────────────────────┬──────────────────┘
                 │ documents (source of truth) │ chunks (vectors)
  ┌─ Storage ────▼─────────────┐  ┌─ Storage ──▼─────────────────┐
  │ agents.documents           │  │ agents.chunks (on conflict   │
  │ (content, source_path)     │  │  do update → idempotent)     │
  └────────────────────────────┘  └──────────────────────────────┘
```

Zoom in. You've run a RAG ingest before, so you know the naive version: re-embed everything every time. buffr is past that — `npm run index -- file.md` indexes *one* file, and `on conflict do update` makes re-running it idempotent. That's genuinely incremental at the file grain. But be honest about the edge: there's **no change-detection** (it re-embeds whether or not the file changed) and **no deletion handling** (delete a file and its chunks linger). This file builds what's there and names the gap precisely — the next step is dirty-flagging and deletes, not a rewrite.

## Structure pass

Read the skeleton: indexing crosses three layers; trace one axis to see exactly how incremental it is.

**Layers:** CLI (chooses which files) → runtime (writes the document + triggers chunking/embedding) → storage (upserts vectors).

**Axis traced — "at what granularity is a change applied?"**

```
  one axis: granularity of a write

  ┌─ CLI ──────────────────┐   PER FILE — argv lists the files; each is
  │  for path of paths      │   indexed independently (not a full corpus)
  └────────────┬───────────┘
               │ seam: file → (document row + chunks)
  ┌─ runtime ──▼───────────┐   PER DOCUMENT — one documents row upserted,
  │  indexDocumentRow       │   then ALL its chunks re-embedded (no diff)
  └────────────┬───────────┘
               │ seam: chunks → rows
  ┌─ storage ──▼───────────┐   PER CHUNK — on conflict (id) do update;
  │  on conflict do update  │   same chunk id overwrites, no duplicate
  └─────────────────────────┘
```

**The seam that matters:** runtime → storage, the document-to-chunks boundary. This is where buffr is incremental *and* where its gap lives. Per file and per chunk it's surgical (idempotent upsert by stable id). But *within* a re-indexed document, every chunk is re-embedded unconditionally — there's no "did this chunk's text change?" check — and chunks that *disappeared* (the file got shorter) are never deleted. Hold that: the granularity is file-level, and the missing pieces are sub-document change-detection and deletion.

## How it works

### Move 1 — the mental model

You know how a React re-render *could* rebuild the whole tree, but the reconciler instead diffs and patches only what changed — and how `key` props let it match old nodes to new ones so it doesn't throw away and recreate? Incremental indexing is that idea applied to a vector store. The chunk `id` (`"<docId>#<index>"`) is the `key`. Re-indexing a file re-uses those keys, so `on conflict do update` *patches* the matching rows instead of inserting duplicates.

```
  the incremental-index kernel — stable ids let writes patch

   index file.md again:
     chunk "file.md#0" ─► on conflict (id) ─► UPDATE row (patch)
     chunk "file.md#1" ─► on conflict (id) ─► UPDATE row (patch)
     chunk "file.md#2" ─► (new) no conflict ─► INSERT row

   stable id = the "key" that matches old chunk → new chunk
   missing from re-run: a chunk that USED to exist (#3) is NOT deleted
```

The kernel: a stable per-chunk id + an upsert keyed on it. That alone makes re-indexing one file idempotent. The two things it's missing — detecting whether a re-index is even needed, and removing vanished chunks — are hardening on top, not part of the kernel.

### Move 2 — the step-by-step walkthrough

**Step 1 — the CLI loops per file.** You hand `npm run index` one or more paths; it reads each and indexes it independently. There's no "scan the whole corpus" — the unit of work is the file you named:

```ts
// src/cli/index-cmd.ts:22-27
for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
  process.stdout.write(`indexed ${path}\n`);
}
```

The document `id` is `basename(path)` — so `notes.md` always maps to the same documents row and the same chunk-id prefix `notes.md#…`. That stable identity is what makes a *re*-index update-in-place rather than accumulate duplicates. The boundary condition: rename the file and it's a *new* document (new id) — the old one's chunks stay behind. Identity is by filename, not by content.

```
  Pattern — per-file unit of work

  npm run index -- a.md b.md
     │
     ├─► a.md ─► readFile ─► indexDocumentRow(id="a.md")  (independent)
     └─► b.md ─► readFile ─► indexDocumentRow(id="b.md")  (independent)

  no full-corpus scan; each file is its own atomic index
```

**Step 2 — write the documents row first, then index.** `indexDocumentRow` does two writes in order: the source-of-truth `documents` row, then the chunk vectors. The documents row is itself an upsert:

```ts
// src/runtime.ts:11-17
await pool.query(
  `insert into agents.documents (id, app_id, source_type, source_path, content)
   values ($1, $2, 'markdown', $3, $4)
   on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
await pipeline.index({ id: doc.id, text: doc.text });   // then chunk → embed → upsert chunks
```

Order matters. The `documents.content` row is the *original text* — the thing you'd re-embed from if you ever switched models (`02-embedding-model-choice.md`). Writing it first means even if the embedding step fails, the source text is captured. The `on conflict do update` means re-indexing the same file overwrites its content, not duplicates the document. This is the same idempotency idea as the chunks, one layer up.

```
  Layers-and-hops — one index run

  ┌─ runtime ────────┐ hop 1: upsert documents row    ┌─ Postgres ──────┐
  │ indexDocumentRow │ ──────────────────────────────►│ agents.documents│
  └────────┬─────────┘  (source of truth written 1st) │ on conflict upd │
           │ hop 2: pipeline.index({id, text})         └─────────────────┘
           ▼
  ┌─ aptkit pipeline ┐ hop 3: chunk → embed → upsert   ┌─ Postgres ──────┐
  │ indexDocument    │ ──────────────────────────────► │ agents.chunks   │
  └──────────────────┘  ids "id#0".."id#n"             │ on conflict upd │
                                                        └─────────────────┘
```

**Step 3 — chunks upsert by stable id (idempotent re-index).** Inside `pipeline.index`, the text is chunked, every chunk embedded, and each upserted under id `"<docId>#<i>"`. The store's `on conflict (id) do update` makes re-running a file overwrite each chunk:

```ts
// aptkit packages/retrieval/src/pipeline.ts:37-46
const texts = chunkText(doc.text);
if (texts.length === 0) return;
const vectors = await wiring.embedder.embed(texts);
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,                  // ← stable: "notes.md#0", "notes.md#1", ...
  vector: vectors[i]!,
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
}));
await wiring.store.upsert(chunks);       // store does INSERT ... ON CONFLICT DO UPDATE
```

```ts
// src/pg-vector-store.ts:50-54  (the conflict clause that makes it idempotent)
on conflict (id) do update set
  document_id = excluded.document_id, app_id = excluded.app_id,
  chunk_index = excluded.chunk_index, content = excluded.content,
  embedding = excluded.embedding, ...
```

Re-index `notes.md` after editing it: chunk `notes.md#0` already exists, so it's *updated* with the new content and embedding — no duplicate. That's real incremental behavior at the file grain.

**Step 4 — here's the honest gap.** Two things this does NOT do, and you should be able to name them cold:

*No change-detection.* Re-indexing always re-chunks and re-embeds the entire file, even if a single word changed or nothing changed. There's no hash/`mtime` check that says "skip this file, it's unchanged" — embedding is the expensive step, and buffr pays it every run. (This is the same gap `09-stale-embeddings.md` covers from the freshness side: no `embedding_stale_at`, no dirty flag.)

*No deletion handling.* If you edit `notes.md` to be *shorter* — say it now produces 3 chunks where it used to produce 5 — chunks `notes.md#3` and `notes.md#4` are never touched. The upsert overwrites `#0`–`#2`, but `#3`/`#4` are *orphans*: stale vectors that still match queries. And deleting the file entirely leaves *all* its chunks behind, because nothing issues a `delete`.

```
  Comparison — what's incremental vs what's missing

  EXERCISED (works today)            MISSING (Case-A next step)
  ┌──────────────────────────┐       ┌──────────────────────────┐
  │ per-file unit of work     │       │ change-detection          │
  │ stable chunk ids          │       │  (re-embeds even if same) │
  │ on conflict do update     │       │ shrink → orphan chunks    │
  │  (idempotent re-index)    │       │  (#3,#4 never deleted)    │
  │ documents row first       │       │ delete file → chunks stay │
  └──────────────────────────┘       └──────────────────────────┘
   surgical at file grain            no dirty-flag, no delete sweep
```

### Move 3 — the principle

Incremental indexing is a reconciliation problem: you have an old set of vectors and a new set of chunks, and you must compute the *delta* — what to update, what to insert, **and what to remove**. buffr nails the first two with stable ids and upsert, which is the hard 80%. The remaining 20% — detecting that a re-index is even needed, and deleting vectors whose source is gone — is the part that bites in production, because a vector store silently accumulates stale, query-able garbage when only upserts ever run. The lesson: an index that only ever upserts is half a reconciler. The deletes are the other half.

## Primary diagram

The index path as it runs today, with the gap marked:

```
  buffr incremental indexing — per-file upsert (and what it misses)

  npm run index -- notes.md
     │ readFile, id = "notes.md"
     ▼
  ┌─ indexDocumentRow (src/runtime.ts) ───────────────────────────┐
  │  1. upsert agents.documents (content = source of truth)       │
  │  2. pipeline.index({id, text})                                │
  └───────────────────────────┬───────────────────────────────────┘
                              │ chunk(512/64) → embed(768)
                              ▼
  chunks: notes.md#0  notes.md#1  notes.md#2
     │ on conflict (id) do update  (idempotent — patch in place)
     ▼
  ┌─ agents.chunks ───────────────────────────────────────────────┐
  │  #0 patched   #1 patched   #2 patched                          │
  │  ⚠ #3 #4 from a longer prior version → ORPHANED (no delete)    │
  │  ⚠ no hash check → re-embeds even when text is unchanged       │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The full-rebuild-vs-incremental tension is ancient — it's the same as a build system choosing between rebuilding everything and tracking dependencies to rebuild only what changed. Full rebuild is dead simple and always correct (drop all chunks, re-embed the corpus), but it's O(corpus) on every change and re-pays the embedding cost for unchanged files. Incremental is O(delta) but demands you track identity (which chunk is which — buffr's stable ids) *and* lifecycle (which chunks died — buffr's gap).

The deletion gap connects straight to the dropped FK in `04-vector-databases.md`: because there's no `on delete cascade` from documents to chunks (there's no FK at all), deleting a documents row would *not* clean up its chunks even if you added document-deletion. So a complete fix is two moves: detect-and-skip-unchanged (a content hash on the documents row), and delete-orphans (either a post-index sweep that removes `id`s beyond the new chunk count, or an explicit delete-by-`document_id`). Both are small, both are real product gaps, and naming them precisely is the senior move.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Delete orphaned chunks on re-index

- **Exercise ID:** INC-1 (Case A — close the deletion gap).
- **What to build:** after `pipeline.index()` writes N chunks for a document, delete any `agents.chunks` rows for that `document_id` whose `chunk_index >= N` — removing the orphans left when a file shrinks. Same for an explicit `npm run index:rm -- file.md` that deletes the documents row *and* all its chunks.
- **Why it earns its place:** "my index handles deletes, not just upserts" is the difference between a toy ingest and a reconciler; the orphan bug is a real, demonstrable correctness failure.
- **Files to touch:** `src/runtime.ts` (add a delete-orphans query after `pipeline.index`, scoped by `document_id` and `chunk_index`), new `src/cli/index-rm-cmd.ts`; chunks schema at `sql/001_agents_schema.sql:14-25`.
- **Done when:** re-indexing a shortened file leaves zero orphan chunks, proven by a test that indexes a long doc then a short one and counts rows.
- **Estimated effort:** half a day.

### Skip unchanged files with a content hash

- **Exercise ID:** INC-2 (Case A — add change-detection).
- **What to build:** store a content hash on the `agents.documents` row; on re-index, compute the new file's hash and skip chunking/embedding entirely when it matches — so unchanged files cost one cheap hash, not a full re-embed.
- **Why it earns its place:** embedding is the expensive step; re-embedding unchanged files is wasted compute, and skipping it is the first lever any real ingest pulls.
- **Files to touch:** add a `content_hash` column in `sql/`, compute it in `indexDocumentRow` (`src/runtime.ts:11-17`), short-circuit before `pipeline.index` when unchanged.
- **Done when:** re-indexing an untouched file performs no embedding calls (verified by a spy/log), and an edited file still re-indexes.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: Is buffr's indexing incremental or a full rebuild — and where's the catch?**
Answer: incremental at the file grain. `npm run index -- file.md` indexes one named file, and every chunk upserts under a stable id `"<docId>#<i>"` with `on conflict do update`, so re-running a file patches its rows instead of duplicating them. The catch is two missing pieces: no change-detection (it re-embeds even when the file is unchanged) and no deletion handling (shrink a file and chunks `#3`,`#4` orphan; delete a file and all its chunks linger). An index that only upserts is half a reconciler.

```
  re-index notes.md (now 3 chunks, was 5)
  #0 #1 #2 → on conflict update ✓
  #3 #4    → never touched → ORPHANED stale vectors ✗
```

**Q: Why write the documents row before the chunks?**
Answer: `agents.documents.content` is the source of truth — the original text. Writing it first means even if embedding fails, the text is captured, and it's the input you'd re-embed from if you ever switched embedding models. It's the same idempotent `on conflict do update` as the chunks, one layer up. The anchor: **the load-bearing ordering people skip is persisting the source text before the derived vectors — derived data should never be the only copy.**

```
  documents row (source text) ──first──► chunks (derived vectors)
  embedding fails? source still saved → re-embed later, no file re-read
```

## See also

- `02-embedding-model-choice.md` — why `documents.content` (written here first) is the re-embed escape hatch.
- `04-vector-databases.md` — the idempotent upsert and the dropped FK that complicates cascade-delete.
- `09-stale-embeddings.md` — the freshness side of the same change-detection gap.
- `11-rag.md` — the query path that reads what this write path produces.

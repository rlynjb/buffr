# Incremental Indexing

### *industry: incremental indexing / delta vs full rebuild · type: keeping the index current without re-embedding everything*

## Zoom out

The last file was about *noticing* a doc went stale. This one is about the *update strategy* once you know: do you rebuild the whole index, or just the deltas? And what about deletes? buffr is partway here — precisely partway, and being precise about which part matters.

**buffr's retrieval stack, the update strategy marked**

```
┌──────────────────────────────────────────────────────────────┐
│  agents.chunks          the index being kept current           │
├──────────────────────────────────────────────────────────────┤
│  ★ INDEXING STRATEGY ★  per-file upsert by id                 │  ◄── this file
│                         incremental-by-file, NO delete/change  │
│                         detection                              │
├──────────────────────────────────────────────────────────────┤
│  npm run index -- <files>   re-runnable, idempotent            │
└──────────────────────────────────────────────────────────────┘
```

On your last app, "re-index" probably meant "wipe and rebuild." buffr is more granular than that — but less granular than a real change-detecting pipeline. This file pins exactly what buffr does and doesn't do, because the honest answer is "incremental, but only halfway."

## Structure pass

The axis is **update granularity**: rebuild everything vs. touch only what changed. The seam is *change detection* — knowing which docs are deltas, and which were deleted.

**Full rebuild vs. delta, and where buffr sits**

```
   FULL REBUILD                      TRUE DELTA (not buffr)
   ────────────                      ──────────────────────
   wipe all chunks                   detect changed docs → re-embed those
   re-embed entire corpus            detect deleted docs → remove their chunks
   simple, wasteful                  detect new docs → add them
   ┌──────────────┐                  ┌──────────────────────────┐
   │ drop + index │   ──seam──►      │ change-detect ──► apply    │
   └──────────────┘                  └──────────────────────────┘
                 ▲ buffr is HERE: ──────┘
   incremental-by-FILE (upsert per file you name) but NO
   change-detection and NO delete handling
```

The seam is change detection. Left of it: rebuild everything, no detection needed. Right of it: a pipeline that figures out adds/changes/deletes and applies only those. buffr sits *on* the seam — it upserts per file you explicitly hand it (so it's incremental-by-file), but it never *detects* what changed and never *deletes*. Consequence: buffr can cheaply re-index a file you know changed, but it cannot notice a file you forgot, and it cannot remove a doc you deleted.

## How it works

### Move 1 — Mental model: `git add <file>` with no `git status` and no `git rm`

buffr's indexer is like staging files by name: `npm run index -- work.md` updates exactly work.md, idempotently. What's missing is the `git status` that tells you *which* files changed, and the `git rm` that handles deletions. You can update precisely — if you already know what to update.

**Index-by-name, no status, no remove**

```
  npm run index -- work.md stack.md     ◄── you name the files
        │
        ▼ each file: upsert its chunks by id (idempotent)
  ┌──────────────────────────────────────────┐
  │ ✓ updates files you name                  │
  │ ✗ no detection of what changed (no status)│
  │ ✗ no removal of deleted docs (no rm)      │
  └──────────────────────────────────────────┘
```

Frontend bridge: it's a manual cache-bust where you type the asset paths to invalidate, with no build step diffing the manifest and no cleanup of removed assets. Precise when you're right, silent when you forget.

### Move 2 — Walk the mechanism

**Part A — Per-file upsert by id (the incremental part that DOES exist)**

You hand the indexer specific files; each is upserted by stable id, so re-indexing one file replaces only that file's chunks without touching others.

**Incremental-by-file**

```
  npm run index -- coffee.md
        │
        ▼ readFile → indexDocumentRow(id = basename = "coffee.md")
        ▼ documents: upsert by id ; pipeline.index → chunks upsert by "<id>#<i>"
  ┌──────────────────────────────────────────┐
  │ only coffee.md's rows touched              │
  │ work.md, stack.md chunks untouched         │
  └──────────────────────────────────────────┘
```

```ts
// src/cli/index-cmd.ts:22-26 — per-file, by basename id
for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
}
```

This *is* genuinely incremental at file granularity. The `basename` becomes the stable doc id, chunk ids are `"<docId>#<i>"`, and `on conflict do update` replaces in place. Re-running `index -- coffee.md` after editing coffee.md is correct and cheap — it never rebuilds work.md or stack.md. Credit where due: buffr is not a wipe-and-rebuild system.

**Part B — No change detection, no delete handling (the gaps that DON'T)**

Two precise omissions. buffr never *figures out* which files changed (you must name them), and it never *removes* chunks for a deleted document.

**The two missing operations**

```
  CHANGE DETECTION (missing)         DELETE HANDLING (missing)
  ─────────────────────────         ─────────────────────────
  edit a file, forget to             delete coffee.md from disk
  re-index it ──► stale (file 09)    re-run index over the rest
  buffr never scans for diffs        ──► coffee.md's chunks REMAIN
  ┌──────────────────────┐           ┌──────────────────────────┐
  │ no manifest diff      │          │ no DELETE for orphaned     │
  │ no mtime/hash check    │          │ document rows or chunks    │
  └──────────────────────┘           └──────────────────────────┘
```

There's no code to cite for these because they don't exist — which is the point. If you delete a source file, its chunks linger in `agents.chunks` forever and can still be retrieved and cited. If you edit a file but don't re-run its index, it's stale (file 09). buffr handles the *add/update-by-name* third of the delta problem and skips the *detect* and *delete* thirds.

### Move 2.5 — Current vs. future

**Be precise: buffr is incremental-by-file via id upsert, but has no change-detection and no delete path.**

```
  TODAY                              FULL DELTA PIPELINE (the gap)
  ─────                              ─────────────────────────────
  index -- <named files>             scan corpus ──► diff vs indexed:
  upsert by id (incremental)           • new ──► index
  ✓ add / update (by name)             • changed (hash/mtime) ──► re-index
  ✗ detect changes                     • deleted ──► remove chunks
  ✗ delete removed docs              ┌──────────────────────────────┐
  ┌──────────────────┐               │ change-detect ──► apply deltas │
  │ manual file list │               │ incl. tombstone/delete         │
  └──────────────────┘               └──────────────────────────────┘
```

The missing pieces are *detection* (hash/mtime diff against what's indexed — shares the content-hash with file 09) and *deletion* (remove a doc's chunks when its source is gone). Both are bounded additions on top of the working upsert.

### Move 3 — The principle

**Incremental indexing is three operations — add, change, delete — and "we have upsert" only covers one and a half.** The honest framing matters: buffr *is* incremental in the cheap, correct sense (id-based upsert per named file), so don't oversell it as wipe-and-rebuild *or* undersell it as a real delta pipeline. The gaps are specific and nameable: no change detection, no delete handling. A full-rebuild is simpler but wasteful; a true delta pipeline is the goal; buffr is a defensible waypoint that you must describe precisely or you'll mislead in an interview.

## Primary diagram

What buffr does, against the full delta picture.

**Three delta operations, buffr's coverage marked**

```
  source files ──────────────► agents.chunks
        │
        ├─ ADD new doc        ──► ✓ index -- newfile.md  (upsert)
        ├─ CHANGE existing    ──► ✓ index -- edited.md   (upsert by id)
        │                         ✗ but only if YOU remember (no detection)
        └─ DELETE removed doc ──► ✗ chunks linger forever (no delete path)
  ──────────────────────────────────────────────────────────────────────
  buffr = incremental-by-FILE upsert
  gaps  = change-detection (which files?) + delete (remove orphans)
```

After the box: the upsert engine is sound; the missing parts are the *decisions around it* — what to touch, and what to remove.

## Elaborate

- **Full rebuild is the honest fallback.** When in doubt, `npm run index` over every file rebuilds correctly (upsert overwrites). It's wasteful but never wrong — a fine operational escape hatch while the delta pipeline doesn't exist. The cost is re-embedding unchanged docs.
- **Delete is the sharpest gap.** A stale *edit* eventually gets re-indexed; a *deleted* doc's chunks never leave on their own. That's an unbounded accumulation of retrievable, citable ghosts. Of the two gaps, delete-handling is the more dangerous because nothing ever cleans it up.
- **Detection shares machinery with staleness.** The content-hash from file 09's exercise *is* the change-detection signal — diff source hashes against indexed hashes to find the changed set. Build it once, use it for both freshness reporting and delta indexing.
- **`source_path` and `created_at` are seeds for a manifest.** `documents` already stores `source_path` and `created_at`. A change-detector can scan those paths' mtimes/hashes against the indexed set — the raw material for a real delta scan is already in the schema.

## Project exercises

### Add delete handling (remove chunks for vanished source docs)

- **Exercise ID:** [B2B.12] (cite [C2.9], Phase 2B) — Case B: buffr has **no delete handling**. This is the primary target — the sharpest gap.
- **What to build:** A pass that, given the current set of source files, deletes `documents` rows and their `agents.chunks` whose `source_path` no longer exists on disk. Make it safe (dry-run first, then apply).
- **Why it earns its place:** Deleted docs' chunks linger forever and stay retrievable/citable — an unbounded correctness leak nothing else cleans up. This is the most dangerous of the two named gaps.
- **Files to touch:** a new CLI command using `documents.source_path` (`sql/001_agents_schema.sql` shape), deleting from both tables; reuse `src/db.ts`.
- **Done when:** Deleting a source file and running the pass removes exactly that doc's rows and chunks, verified by a search no longer returning it.
- **Estimated effort:** 1 day.

### Add change-detection (delta indexing by content hash)

- **Exercise ID:** [B2B.13] (cite [C2.9], Phase 2B) — Case B: buffr has **no change detection** (depends on / shares [B2B.10]'s hash).
- **What to build:** A scan that diffs each source file's content hash against the indexed hash and re-indexes only the changed/new files — so `index` over a directory touches only deltas instead of everything.
- **Why it earns its place:** It removes the "you must name the changed files" footgun and the wasteful full rebuild, turning buffr into a true add/change/delete delta pipeline alongside [B2B.12].
- **Files to touch:** `src/cli/index-cmd.ts` (scan + diff before upserting), reusing the `content_hash` column from [B2B.10].
- **Done when:** Running index over a directory re-embeds only files whose hash changed, skipping unchanged ones, with the skip count reported.
- **Estimated effort:** 1 day (after [B2B.10]).

## Interview defense

**Q: "Is buffr's indexing incremental or full-rebuild?"**

Incremental — but precisely, incremental-by-file. You name files, each is upserted by stable id (`"<docId>#<i>"`), so re-indexing one file replaces only its chunks. It's not wipe-and-rebuild. But it has no change detection and no delete handling.

```
  index -- file.md ──► upsert by id ──► only that file's chunks change
```

Anchor: *"Incremental at file granularity, by id upsert."*

**Q: "What breaks at the edges?"**

Two precise gaps. No change-detection — edit a file and forget to re-index it, and it's silently stale. No delete-handling — delete a source file and its chunks linger forever, still retrievable and citable. Delete is the worse one; nothing ever cleans it up.

```
  forgot to re-index ──► stale (no detection)
  deleted source ──► orphan chunks remain (no delete)
```

Anchor: *"Add/update by name works; detect and delete don't."*

## See also

- `./09-stale-embeddings.md` — the freshness side; shares the content-hash that powers change detection.
- `./04-vector-databases.md` — the idempotent `on conflict` upsert that makes per-file re-index safe.
- `./11-rag.md` — orphan chunks from missing deletes can still surface as cited answers.
- `../../study-database-systems/` — change-data-capture, tombstones, manifest diffing.

# Embedding Roundtrip — batched-per-doc, serial-across-files

**Industry name(s):** embedding generation; request batching vs request serialization; pipeline stall (GPU idle). **Type:** Industry standard.

Embedding text into 768-dim vectors is an HTTP roundtrip to Ollama. buffr already does the *hard* batching right — and then leaves an easy parallelization on the floor at index time.

## Zoom out, then zoom in

Every chunk that gets stored, and every query that gets searched, first passes through the embedding model. That model lives in Ollama, across an HTTP boundary. So "how slow is embedding" is really "how many HTTP roundtrips, and do they overlap."

```
  Zoom out — where the embedding roundtrip lives

  ┌─ Index CLI ──────────────────────────────────────────────────┐
  │  src/cli/index-cmd.ts   for (path of paths) { await ... }     │ ◄ serial here
  └───────────────────────────┬───────────────────────────────────┘
                              │  indexDocumentRow → pipeline.index
  ┌─ Retrieval pipeline (aptkit) ─────────────────────────────────┐
  │  chunk the doc → ★ embed ALL chunks in ONE /api/embed call ★  │ ◄ batched here
  └───────────────────────────┬───────────────────────────────────┘
                              │  HTTP POST
  ┌─ Provider — Ollama ───────▼───────────────────────────────────┐
  │  nomic-embed-text:v1.5  →  768-dim vectors                    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: there are two batching decisions stacked here, and buffr gets one right and one wrong. **Within a document:** all chunks go in one call — good batching. **Across documents:** files are processed one at a time, fully, before the next starts — serialization, with the GPU sitting idle while each file does its database writes.

## The structure pass

Axis: **lifecycle** — *when* does each embedding roundtrip happen, and what's the GPU doing between them?

```
  axis = "what is the GPU doing?"  — traced across the index loop

  file A: embed(all chunks) ──► [GPU busy] ──► write rows ──► [GPU IDLE]
                                                                  │
  file B: embed(all chunks) ──► [GPU busy] ──► write rows ──► [GPU IDLE]
                                  ▲
                                  └─ seam: the GPU goes idle through
                                     every file's DB writes because the
                                     NEXT file's embed waits for this
                                     file's writes to finish (for-await)
```

**Layers:** per-file loop (serial) → per-doc pipeline (batched) → Ollama (the GPU). **Seam:** the `for...await` in `index-cmd.ts` — control flips from "could be concurrent" to "strictly sequential" right there. The batching seam inside the pipeline is fine; the serialization seam in the CLI is the cost.

## How it works

### Move 1 — the mental model

You know how `Promise.all([fetchA(), fetchB()])` lets two requests overlap, but `await fetchA(); await fetchB();` forces the second to wait for the first to fully finish? That's the entire shape here. The per-document embed is one efficient request. The cross-file loop is the `await; await;` version — and the thing each file waits on isn't just its own embed, it's its own *database writes* too, during which the GPU has nothing to do.

```
  serial (now)              vs    overlapped (possible)

  A:embed▓▓ A:write░░             A:embed▓▓ A:write░░
                B:embed▓▓ B:write░░    B:embed▓▓ B:write░░
                                       ▲ B embeds while A writes
  GPU: ▓▓......▓▓......            GPU: ▓▓▓▓............
       idle through writes             back-to-back, then idle
```

### Move 2 — the step-by-step walkthrough

**The serialization, in the CLI.** This is the cost, and it's four lines (`src/cli/index-cmd.ts:22-26`):

```ts
for (const path of paths) {
  const text = await readFile(path, 'utf8');           // I/O wait
  await indexDocumentRow(pool, cfg.appId, pipeline,    // embed + DB writes,
    { id: basename(path), text, sourcePath: path });   //   fully awaited
  process.stdout.write(`indexed ${path}\n`);
}
```

What breaks if you reorder: nothing functionally — the docs all get indexed. What's *lost*: the `await indexDocumentRow(...)` blocks the loop until that file's embed *and* its INSERTs are both done. The next file's embed can't start until this file's database round-trips finish. So the GPU — the expensive, serial resource — goes idle during every file's write phase. With 10 files you pay 10 sequential (embed + write) cycles instead of overlapping file B's embed with file A's write.

**The batching, in the pipeline (the part that's right).** Inside `pipeline.index` (aptkit, consumed via `indexDocumentRow` at `src/runtime.ts`), a document's chunks are embedded in a *single* `/api/embed` call carrying all chunk texts at once. This is the batching that actually matters: it amortizes the HTTP roundtrip and the model's startup overhead across every chunk in the doc.

```
  per-doc batching — the part buffr gets right

  doc → [chunk1, chunk2, ... chunkN]
              │ ONE call, not N
              ▼
   POST /api/embed { input: [c1, c2, ... cN] }
              │
              ▼
   [v1, v2, ... vN]   ← N vectors, one roundtrip
```

What would break without it: N separate HTTP calls per document, each paying connection + model-load overhead. That's the expensive mistake, and buffr avoids it. The serialization across files is the *cheap* mistake left in place.

**Why this is correctly deprioritized.** Indexing is a manual, one-shot CLI you run when you add documents (`npm run index -- file.md`). It is not on any hot path, not on a chat turn, not user-facing latency. Fixing the serialization (a bounded `Promise.all` over files, or `p-limit` with a small concurrency) is a real speedup for large index runs and a 20-minute change — but it earns nothing on a 5-file corpus, and the dominant chat-turn cost (`gemma2:9b`) is untouched by it either way.

### Move 3 — the principle

Batch the expensive serial resource; overlap independent work. buffr batches the embed roundtrip *within* a document (the right instinct) but serializes *across* documents, parking the GPU during I/O. The general lesson: find the resource that's both expensive and serial — here, the embedding model — and make sure it's never idle while waiting on something that could have run concurrently. The fix is cheap; whether it's worth doing is a question of how often you re-index, which is unmeasured.

## Primary diagram

```
  Embedding roundtrip — two batching decisions, one right, one not

  ┌─ Index CLI (src/cli/index-cmd.ts:22) ────────────────────────┐
  │  for path of paths:  await indexDocumentRow(...)              │
  │     ▲ SERIAL across files — GPU idle through each file's      │
  │       DB writes  (the cheap miss, low priority)               │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ pipeline.index (aptkit) ─▼───────────────────────────────────┐
  │  chunk doc → embed ALL chunks in ONE /api/embed call          │
  │     ▲ BATCHED per doc — amortizes the roundtrip (the win)     │
  └───────────────────────────┬───────────────────────────────────┘
                              │  HTTP (one roundtrip per doc)
  ┌─ Ollama ──────────────────▼───────────────────────────────────┐
  │  nomic-embed-text:v1.5 → 768-dim vectors                      │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The per-doc batching is a property of aptkit's pipeline, not buffr — buffr consumes `createRetrievalPipeline` and gets the batching for free (`src/cli/index-cmd.ts:20`). The serialization is buffr's, in its own CLI loop. That split matters for where you'd make the fix: you can't touch the batching (aptkit is consumed, never edited — a hard repo constraint), but the cross-file loop is buffr's to change.

For the HTTP transport underneath `/api/embed` — keep-alive, connection reuse to Ollama, why a roundtrip costs what it does — see **`study-networking`**. For why `nomic-embed-text:v1.5` at 768 dims and what the embedding model is doing, see **`study-ai-engineering`**. This file owns the *batching vs serialization* performance read.

## Interview defense

**Q: Walk me through your embedding throughput at index time.**

> Two layers. Within a document, all chunks embed in one `/api/embed` call — so I pay one HTTP roundtrip per doc, not one per chunk. That's the batching that matters; it amortizes the model-load and network overhead. Across documents though, my CLI loop is `for...await`, so file B's embed waits for file A's embed *and* file A's database writes to finish. The GPU sits idle while each file does its INSERTs. The fix is bounded concurrency over the files so B embeds while A writes.

```
  within doc:  N chunks → 1 call   ✓ batched
  across docs: A then B then C     ✗ serial, GPU idle on writes
```

**Q: Why haven't you fixed the serial part?**

> Because it's not on a hot path. Indexing is a manual one-shot CLI, not a chat turn — no user is waiting on it. On my corpus it's a handful of files and the cost is invisible. I'd fix it the moment re-indexing felt slow, and it's a small change — a `p-limit` over the file loop. But the dominant cost on the path users actually feel is `gemma2:9b` generation, which this doesn't touch, so it's correctly low priority.

> Anchor: `src/cli/index-cmd.ts:22-26` (serial loop), per-doc batching inside `pipeline.index`.

## See also

- `00-overview.md` — finding #2
- `audit.md` — lens 5 (I/O), lens 6 (batching), lens 8 (red flags #5)
- `01-hnsw-approximate-search.md` — the search that consumes these vectors
- `03-per-chunk-insert-loop.md` — the DB writes the GPU waits on
- **`study-networking`** — the HTTP transport to Ollama
- **`study-ai-engineering`** — the embedding model + pipeline

# Embedding Roundtrip

**Industry names:** embedding generation · batched inference · embedding roundtrip.
**Type:** Industry standard (the serial-across-files part is project-specific).

---

## Zoom out, then zoom in

Before any text can be searched, it has to become a vector. That conversion is an HTTP
roundtrip to Ollama, and Ollama runs it on the GPU. There are two questions hiding in
"how fast is indexing": how efficiently does buffr *batch* the embed calls, and how well
does it *overlap* embedding with the database writes around it. The answer is split:
batching is good, overlap is absent.

```
  Zoom out — where embedding sits in the index path

  ┌─ CLI layer (src/cli/index-cmd.ts) ──────────────────────────┐
  │  for (const path of paths)  ← SERIAL across files            │
  │     readFile → indexDocumentRow(...)                         │
  └──────────────────────────────────┬──────────────────────────┘
                                      │
  ┌─ Pipeline (aptkit createRetrievalPipeline) ─▼───────────────┐
  │  chunk doc → ★ embed ALL chunks in ONE call ★ → upsert       │ ← we are here
  └──────────────────────────────────┬──────────────────────────┘
                       embed │ HTTP :11434          │ upsert (pg)
  ┌─ Provider: Ollama ──────▼──────┐  ┌─ Storage: Postgres ──▼──┐
  │  nomic-embed-text:v1.5 (768d)  │  │  agents.chunks INSERTs   │
  │  GPU-bound                     │  │                          │
  └────────────────────────────────┘  └──────────────────────────┘
```

Zoom in: the pattern is **batched-per-document** embedding (good — one HTTP call carries
all of a document's chunks) running inside a **serial-across-files** loop (the cost — file
N+1 doesn't start until file N's commit returns, so the GPU sits idle through every write).
The question this file answers: where does the indexing path actually waste time, and is it
worth fixing?

---

## Structure pass

**Layers.** Two that matter for cost: the *outer* file loop in `index-cmd.ts:22-26`, and
the *inner* per-document pipeline (chunk → embed → upsert) that the loop body calls.

**Axis — lifecycle / overlap (is the GPU busy or idle right now?).** Trace "what is the GPU
doing?" across the two layers:

```
  One question — "is the GPU busy?" — across the loop

  ┌─ inner (one document) ───────────────────────────────┐
  │  embed all chunks  → GPU BUSY (one batched call)      │  good
  │  upsert chunks     → GPU IDLE (DB doing the work)     │
  └──────────────────────────────────────────────────────┘
  ┌─ outer (across files) ───────────────────────────────┐
  │  file N: embed(busy) → write(idle) → COMMIT           │
  │  file N+1: ...waits for N's commit, THEN embeds...    │  ← the idle gap
  └──────────────────────────────────────────────────────┘

  the seam is the await between files: nothing overlaps the GPU with the DB write.
```

**Seam — the `await` between files.** The load-bearing seam is the `await indexDocumentRow(...)`
inside the `for...of` at `index-cmd.ts:24`. Because it's awaited serially, file N+1's
embedding can't begin until file N has fully committed. The GPU — the scarce resource — is
idle for the entire duration of each file's database write. That seam is where the only
real indexing-path latency lives.

---

## How it works

### Move 1 — the mental model

You know how `Promise.all([a, b, c])` runs three async things concurrently, versus a
`for` loop with `await` inside that runs them one after another? buffr's indexer is the
*second* shape — deliberately serial. The mental model: **a pipeline where each stage is
fast, but the stages are run strictly one-file-at-a-time, so the expensive resource (GPU)
goes cold every time the cheap resource (DB) takes a turn.**

```
  Two timelines — serial (now) vs overlapped (possible)

  NOW (serial):
    GPU:  [embed f1]......idle......[embed f2]......idle......[embed f3]
    DB:   ............[write f1].............[write f2].............[write f3]
          └─ GPU idle here ─┘      └─ GPU idle here ─┘

  OVERLAPPED (pipelined):
    GPU:  [embed f1][embed f2][embed f3]
    DB:           [write f1][write f2][write f3]
          └─ GPU stays hot; writes hide behind the next embed ─┘
```

The win on the table is the white space in the first timeline — the GPU idle gaps.

### Move 2 — the walkthrough

**The batching that's already right.** Inside one document, embedding is batched. The
pipeline (`createRetrievalPipeline`, wired at `index-cmd.ts:20`) chunks the document and
sends *all* chunks to Ollama in a single `/api/embed` call, not one call per chunk. That's
the correct shape: one HTTP roundtrip, one GPU dispatch, N vectors back. If this were
per-chunk you'd pay HTTP + GPU-dispatch overhead N times per document; it's paid once.

**The serialization that isn't.** Here's the entire outer loop, `index-cmd.ts:22-26`:

```ts
for (const path of paths) {
  const text = await readFile(path, 'utf8');                          // ← read file N
  await indexDocumentRow(pool, cfg.appId, pipeline,                   // ← embed + write N,
    { id: basename(path), text, sourcePath: path });                 //   AWAITED fully
  process.stdout.write(`indexed ${path}\n`);
}                                                                      // ← only now: file N+1
```

`indexDocumentRow` does the embed *and* the database write for one file, and the `await`
makes the loop block until both finish — including the `commit`. So the timeline is
`embed(f1) → write(f1) → embed(f2) → write(f2) → ...`. While `write(f1)` is happening, the
GPU is idle. While `embed(f2)` is happening, the DB is idle. Nothing overlaps.

**Why this is the one real win.** Of everything in the repo, this is the place buffr's
*own code* (not the model, not Postgres) leaves measurable time on the floor. The fix is a
bounded concurrency over files — embed file N+1 while file N's write is in flight:

```
  pseudocode — overlap embed with write (the available win)

  pending = empty queue
  for each path in paths:
    text = read(path)
    embedJob = embedAndPrepare(text)        // GPU work, can run ahead
    pending.enqueue(embedJob)
    if pending.size >= CONCURRENCY:          // bounded — don't unleash all files at once
      await pending.dequeue().write()        // drain oldest while next embeds
  await all remaining writes
```

**Does it matter at laptop scale?** For indexing a handful of markdown files by hand —
barely; you index rarely and wait once. The moment the corpus is dozens or hundreds of
files (a real personal knowledge base), the cumulative idle gaps are the difference
between an indexing run that feels instant and one you walk away from. It's the highest-
leverage perf change in the repo precisely because it's the only one where the bottleneck
is buffr's loop structure rather than an inherent model or DB cost.

### Move 2.5 — current state vs future state

```
  Phase A — now (serial)                Phase B — overlapped (the fix)
  ────────────────────────────          ──────────────────────────────
  for...await, one file at a time       bounded-concurrency over files
  GPU idle through each write           GPU stays hot; writes hide behind embeds
  correct, simple, fine for a few       same correctness; faster on large corpora
  files                                 cost: a concurrency limit to not OOM / not
                                        overwhelm the single GPU
```

What *doesn't* change: the per-document batching (already right), the upsert logic, the
HNSW index. The fix is purely the loop's concurrency shape.

### Move 3 — the principle

Two independent levers hide inside "make embedding faster": **batch** (fewer roundtrips per
unit of work) and **overlap** (keep the scarce resource busy while the cheap one works).
buffr nailed the first and skipped the second. The discipline is to ask both questions
separately — a batched pipeline can still leave the GPU cold if its stages don't pipeline.

---

## Primary diagram

```
  Embedding roundtrip — full index path with the idle gap marked

  ┌─ CLI: index-cmd.ts ───────────────────────────────────────────────┐
  │  for path of paths:   ← SERIAL (the seam)                          │
  │    read → indexDocumentRow(...) → AWAIT (blocks next file)         │
  └──────────────────────────────┬────────────────────────────────────┘
                                  │
        ┌─────────────────────────┴───────────────────────────┐
        │ inner: chunk → embed(BATCHED, 1 HTTP) → upsert       │
        └───────┬──────────────────────────────────┬──────────┘
        embed   │ HTTP :11434                upsert │ pg wire
  ┌─ Ollama ───▼──────────┐              ┌─ Postgres ▼─────────┐
  │ nomic-embed (GPU BUSY)│   ......      │ INSERTs (GPU IDLE) │
  └───────────────────────┘   ↑ idle gap └─────────────────────┘
                              │
              the white space between embed and the next embed:
              the only latency buffr's own code can reclaim
```

---

## Elaborate

Batched inference is the first thing you learn shipping embeddings at any volume: GPU
dispatch overhead is fixed per call, so amortizing it over many inputs is free throughput.
buffr got that for free from the aptkit pipeline. The serial-across-files gap is the
classic "the batch is fast but the pipeline isn't pipelined" mistake — common because the
naive `for...await` reads correctly and *is* correct, just not overlapped.

This connects to `04-connection-pool-reuse` (the writes are cheap *because* the pool is
warm) and `03-per-chunk-insert-loop` (the write itself is N round-trips, which is the *other*
half of the idle gap's duration). Shorten the write and the idle gap shrinks too.

---

## Interview defense

**Q: Walk me through your indexing throughput. Where's the time going?**

Two stages per file: embed (one batched HTTP call to Ollama, GPU-bound) and upsert (a
transaction of INSERTs). The embed batching is right — all of a document's chunks go in one
call. The cost is that files are processed strictly serially: `index-cmd.ts:24` awaits each
file's full embed-and-commit before starting the next. So the GPU sits idle through every
database write.

```
  GPU:  [embed f1]....idle....[embed f2]....idle....
  DB:   .........[write f1].........[write f2]....
```

The fix is bounded concurrency over files — embed N+1 while N's write is in flight, keeping
the GPU hot. Bounded, not unbounded, because there's one GPU and one pool; I don't want to
fan out infinitely. At my current scale (a few hand-indexed files) it doesn't bite, but it's
the one place my own code leaves latency on the floor, so it's the first thing I'd fix if
the corpus grew.

**Anchor:** `index-cmd.ts:22-26` (the serial loop), and the batching lives in the aptkit
pipeline wired at line 20.

---

## See also

- `03-per-chunk-insert-loop.md` — the write half of the idle gap; shrinking it helps here.
- `04-connection-pool-reuse.md` — why the per-file write is cheap to begin with.
- `06-no-caching.md` — embeds are also recomputed (no cache) on the query side.
- `audit.md` §5, §6 (batching present), §8 (red flag #1, the serial gap).
- `study-networking` — the Ollama HTTP roundtrip and pg wire behind these timings.
- `study-ai-engineering` — embedding models, chunking, the retrieval pipeline.

# Embedding HTTP Round-Trip

*Out-of-process model inference over HTTP; document-serial indexing — Project-specific.*

## Zoom out, then zoom in

Indexing a corpus *feels* like a database operation — you're filling up a table.
But the time doesn't go to the database. It goes to the network hop out to Ollama
to turn text into vectors. Here's the shape, with the expensive box marked.

```
  Zoom out — where indexing time lives

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  npm run index -- a.md b.md c.md   (serial for…await loop)   │
  └─────────────────────────┬────────────────────────────────────┘
                            │  one file at a time
  ┌─ Pipeline (aptkit) ─────▼────────────────────────────────────┐
  │  chunk(text) → ★ embed(chunks) ★ → store.upsert(chunks)      │ ← we are here
  └─────────────────────────┬────────────────────────────────────┘
                            │  HTTP POST /api/embed   ◄── DOMINANT COST
  ┌─ Provider — Ollama (localhost:11434) ───▼────────────────────┐
  │  nomic-embed-text runs the model, returns 768-dim vectors    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: embedding is *model inference* — the GPU/CPU runs a neural net over your
text. That's orders of magnitude slower than the SQL INSERT that follows it. So
the performance question for indexing isn't "how fast is Postgres" — it's "how
many embedding HTTP round-trips do we make, and do they overlap?" The answer has
a surprising shape, and this file corrects a common misreading of it.

## Structure pass

**Layers.** Three: the *file loop* (`index-cmd.ts`, walks paths), the *embed
call* (aptkit's `indexDocument` → `embedder.embed`), and the *transport* (the
`fetch` to `/api/embed`).

**Axis — concurrency (what overlaps vs what waits).** Trace it down:

```
  "what runs in parallel here?" — traced down the layers

  ┌───────────────────────────────────────┐
  │ file loop: for…await over paths        │   → NOTHING overlaps (serial)
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ embed call: embed(ALL chunks)        │   → chunks DO batch (1 call)
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ transport: fetch POST /api/embed │   → single request, array body
          └─────────────────────────────────┘

  the surprise: batching is ALREADY done one layer down (chunks),
  but the layer above it (files) serializes — opposite answers, two layers apart
```

**Seam — the `embed(texts)` call.** This is the joint where the "N round-trips"
intuition is right or wrong depending on which side you stand. *Below* it: one
document's chunks are batched into one HTTP call. *Above* it: documents are
**not** batched — each file gets its own `embed` call, awaited in series. The
concurrency axis flips across this seam, and getting which side does what is the
whole lesson.

## How it works

### Move 1 — the mental model

You know how `Promise.all([fetchA(), fetchB()])` fires both requests at once and
waits for the slower one, while `await fetchA(); await fetchB()` makes the second
wait for the first? Indexing buffr is the second shape *across files* and the
*first* shape (effectively a batch) *within a file*. The strategy: **the
expensive unit is one HTTP inference call; batch as many texts as you can into
each call, and overlap the calls you can't merge.** buffr does the first half and
skips the second.

```
  Two batchings — one done, one not

  WITHIN a document (DONE):
    chunks c0 c1 c2 c3  ──┐
                          ├──► ONE POST /api/embed { input: [c0,c1,c2,c3] }
                          ──┘   one round-trip, four vectors back

  ACROSS documents (NOT done):
    fileA ──► embed ──► insert ──► commit ─┐
                                           ▼ (only now)
    fileB ──► embed ──► insert ──► commit ─┐
                                           ▼ (only now)
    fileC ──► embed ──► insert ──► commit
    wall-clock = sum of all three, no overlap
```

### Move 2 — the moving parts

**The batched embed call.** Bridge from `Promise.all`: aptkit's `indexDocument`
collects *all* of a document's chunks and calls `embedder.embed(texts)` once with
the whole array. The Ollama provider POSTs `{ input: texts }` — Ollama's
`/api/embed` accepts an array and returns one vector per element. So a 4-chunk
document is **one** round-trip, not four. Boundary condition: this only batches
*within* the call it's given; it has no idea other documents exist, so it can't
batch across them.

**The serial file loop.** Bridge: it's the `await fetchA(); await fetchB()`
anti-pattern. `index-cmd.ts` loops `for (const path of paths)` and `await`s
`indexDocumentRow` each iteration. Each iteration does embed → insert → commit
fully before the next starts. Boundary condition: the *embedding* call in file
N+1 — the slow GPU inference — can't even begin until file N's *Postgres commit*
finishes. You're holding the GPU idle during every database write.

```
  The serialization cost — GPU idle during every commit

  time ──────────────────────────────────────────────►
  fileA  [embed.....][insert][commit]
  fileB                              [embed.....][insert][commit]
  fileC                                                         [embed....]
         ▲          ▲
         │          └─ GPU idle here while Postgres commits
         └─ only one embed in flight ever

  with bounded Promise.all (concurrency 3):
  fileA  [embed.....][insert][commit]
  fileB  [embed.....][insert][commit]    ◄ overlapped
  fileC  [embed.....][insert][commit]
         wall-clock ≈ one file's time, not three
```

**The transport.** Bridge: a plain `fetch`. The provider's `defaultHttpTransport`
does `fetch(\`${base}/api/embed\`, { … body: { model, input: texts } })`. One
request, JSON body, vectors back. Boundary condition: no timeout is set on this
fetch in buffr's path and no retry — if Ollama stalls, the index hangs. (That's a
networking finding; cross-linked, not solved here.)

### Move 2 variant — the load-bearing skeleton

The kernel of "fast indexing," and what breaks without each part:

1. **Batch texts into one inference call** — without it, a 50-chunk document is
   50 HTTP round-trips and 50 model warm-ups. *This part is present* (aptkit does
   it). Drop it and per-document cost multiplies by chunk count.
2. **Overlap the independent units** — without it, total wall-clock is the *sum*
   of per-unit times with the GPU idle between them. *This part is absent.* The
   file loop is serial.

The first is the load-bearing batch buffr inherited for free from aptkit. The
second is the hardening buffr hasn't added. Naming which is which is the finding:
the common "N chunks = N round-trips" worry is **already solved** — the real,
unsolved serialization is one layer up, across files.

### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (the cheap win)
  ─────────────                    ──────────────────────
  for (path of paths)              const limit = pLimit(3)
    await indexDocumentRow(path)   await Promise.all(paths.map(p =>
                                     limit(() => indexDocumentRow(p))))

  serial: sum of per-file times    overlapped: ~max of per-file times
  GPU idle during each commit      GPU stays warm across files
```

What doesn't have to change: `indexDocumentRow`, the pipeline, the embed call,
the store. The batching-within-a-document stays exactly as is. Only the *loop* in
`index-cmd.ts:22-26` changes — wrap it in a bounded `Promise.all`. The concurrency
bound matters (don't fire 500 files at one Ollama instance), which is why it's
`pLimit(n)`, not a naked `Promise.all`.

### Move 3 — the principle

When the expensive operation is out-of-process inference, two levers exist:
*merge* calls (batch many inputs into one request) and *overlap* calls (run
independent requests concurrently). They're different levers. buffr pulled the
merge lever (inherited from aptkit) and left the overlap lever untouched.
Knowing which lever is already pulled stops you from "optimizing" the part
that's already optimal.

## Primary diagram

The full index path with both batchings marked.

```
  Index path — files to stored vectors

  ┌─ CLI layer (index-cmd.ts) ──────────────────────────────────┐
  │  paths = [a.md, b.md, c.md]                                  │
  │  for (path of paths) { await indexDocumentRow(path) }  ◄─ SERIAL
  └─────────────────────────┬────────────────────────────────────┘
        per file:           │
  ┌─ Pipeline (aptkit) ─────▼────────────────────────────────────┐
  │  chunkText(doc.text) → [c0, c1, c2, c3]                      │
  │  embedder.embed([c0,c1,c2,c3])   ◄─ BATCHED (one call)       │
  └─────────────────────────┬────────────────────────────────────┘
        hop: POST /api/embed │  HTTP, body { input: [c0..c3] }
                             ▼
  ┌─ Provider — Ollama ──────────────────────────────────────────┐
  │  nomic-embed-text → [v0, v1, v2, v3]  (768-dim each)         │
  └─────────────────────────┬────────────────────────────────────┘
        hop: vectors back    │
                             ▼
  ┌─ Storage — Postgres ─────────────────────────────────────────┐
  │  upsert(chunks) → per-chunk INSERT loop (see 03-)            │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Reached on `npm run index -- <files>` (the main write path into the
corpus) and on the read path during `chat`: each turn embeds the query string once
(`pipeline.query` — one chunk, one call). New as of the `chat` session: **each
turn also pays a second embed round-trip** for episodic memory. After the agent
answers, `memory.remember({ conversationId, question, answer })`
(`src/session.ts:66`, via `createConversationMemory` at `src/session.ts:53`)
embeds the exchange and upserts it into the *same* PgVectorStore (tagged as
memory). So a chat turn is two `/api/embed` calls, not one — the query embed
(before the answer) plus the memory embed (after it). It's a small added per-turn
cost: one more Ollama inference call and one more pg upsert, dominated by the
gemma2 generation between them, but worth naming because it scales with turn
count, not corpus size.

**The serial loop — `src/cli/index-cmd.ts:22-26`:**

```
  src/cli/index-cmd.ts  (lines 22-26)

  for (const path of paths) {                       ← serial driver
    const text = await readFile(path, 'utf8');
    await indexDocumentRow(pool, cfg.appId, pipeline,← AWAIT blocks next file
      { id: basename(path), text, sourcePath: path });
    process.stdout.write(`indexed ${path}\n`);
  }
        │
        └─ the await here is the whole serialization. file N+1's embed
           can't start until file N's commit lands. The fix is to wrap
           the body in a bounded Promise.all — nothing else changes.
```

**The batched embed — `src/runtime.ts:17` → aptkit `indexDocument`:**

```
  src/runtime.ts  (line 17)

  await pipeline.index({ id: doc.id, text: doc.text });
        │
        └─ this single call, inside aptkit, does:
             chunkText(text) → texts[]
             embedder.embed(texts)   ← ALL chunks, ONE /api/embed call
             store.upsert(chunks)
           the batching you'd worry about is already here — per document.
```

**The transport that proves the batch — Ollama provider:**

```
  @aptkit/retrieval ollama-embedding-provider.js  (defaultHttpTransport)

  fetch(`${base}/api/embed`, {
    body: JSON.stringify({ model, input: payload.texts }),  ← ARRAY input
  });
        │
        └─ `input: texts` is the proof: Ollama's /api/embed takes a list and
           returns json.embeddings (one per input). One HTTP call, N vectors.
           This is why "N chunks = N round-trips" is FALSE within a document.
```

## Elaborate

Batching inference inputs is the single highest-leverage move in any embedding
pipeline — every embedding API (OpenAI, Cohere, Voyage, local Ollama) accepts a
batch and charges/latency-amortizes per request, not per input. The pattern buffr
*inherited* (batch within a unit) is the standard one. The pattern it's *missing*
(overlap independent units) is the standard follow-up, usually a `p-limit` or a
bounded worker pool.

The deeper point for buffr: the cost model of indexing is "number of HTTP
inference calls × per-call latency, minus overlap." buffr minimized the count
(batching) but not the overlap (serial loop). What to read next:
`03-per-chunk-insert-loop.md` for the *write* that follows the embed,
`study-runtime-systems` for how `for…await` serializes and how `Promise.all`
overlaps, `study-networking` for the missing timeout/retry on the fetch.

## Interview defense

**Q: Indexing 100 markdown files is slow. Where's the time, and what do you fix
first?**
The time is in embedding HTTP — model inference, not Postgres. First, confirm the
chunks within each file are already batched into one `/api/embed` call (they are,
via aptkit). So the fix isn't batching chunks — it's overlapping *files*. The loop
in `index-cmd.ts` is serial `for…await`; wrap it in a bounded `Promise.all` so
files N and N+1 embed concurrently instead of the GPU idling through each commit.

```
  serial:   sum(file times),    GPU idle between files
  bounded:  ~max(file times),   GPU stays warm
  fix is the LOOP, not the embed call
```

Anchor: `src/cli/index-cmd.ts:22-26` is the serial loop; the batch is already in
`src/runtime.ts:17` → aptkit.

**Q: The part people get wrong here?**
They "optimize" by batching chunks — but that's already done. The real
serialization is one layer up, across documents, and you only see it if you read
the transport (`input: texts` proves the per-doc batch) before you read the loop.

## Validate

1. **Reconstruct:** draw both batchings — within-document (done) and
   across-document (not) — from memory.
2. **Explain:** why is "N chunks = N HTTP calls" false for one document but the
   wall-clock still scales linearly with file count?
3. **Apply:** rewrite `src/cli/index-cmd.ts:22-26` to overlap files with a
   concurrency cap of 3. What must you *not* break in `indexDocumentRow`?
4. **Defend:** argue why you'd cap concurrency at 3 instead of firing all files
   at Ollama at once.

## See also

- `audit.md` § io-network-and-database-bottlenecks, § caching-batching-and-backpressure
- `03-per-chunk-insert-loop.md` — the write that follows each embed
- `04-connection-pool-reuse.md` — the pool the inserts ride on; carries the
  per-turn memory upsert across the whole chat session
- `study-runtime-systems` — `for…await` serialization vs bounded `Promise.all`
- `study-networking` — the `/api/embed` transport, timeouts, retries

---

Updated: 2026-06-24 — Re-verified: chunks-batch-per-doc / serial-across-files
correction still holds (`index-cmd.ts:22-26` unchanged). Added the new per-turn
memory embed: each `chat` turn now makes a SECOND `/api/embed` call +
upsert via `memory.remember` (`session.ts:53,66`) on top of the query embed —
a small added per-turn cost. Read path reframed from `ask` to `chat`.

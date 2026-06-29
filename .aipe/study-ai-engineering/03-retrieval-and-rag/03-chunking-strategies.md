# Chunking strategies — the fixed 512/64-char window

*Industry standard (exercised, but un-tuned). The splitter buffr inherits from aptkit.*

## Zoom out, then zoom in

Pull up the index path and find the very first transform a document hits. Before anything gets embedded, the raw text is *cut into pieces*. That cut decides what a "unit of retrieval" is — and buffr doesn't choose it. It inherits whatever aptkit's chunker does, which is a fixed-size character window.

```
  Zoom out — where chunking sits (first step of the index path)

  ┌─ CLI ───────────────────────────────────────────────────────┐
  │  npm run index -- file.md   (reads the whole file)           │
  └───────────────────────────┬─────────────────────────────────┘
                              │ doc.text (one big string)
  ┌─ Retrieval pipeline (aptkit) ─────────────────────────────────┐
  │  ★ chunkText(text) — fixed 512-char windows, 64 overlap ★     │ ← here
  │       │ texts[]                                                │
  │       ▼  embed each → upsert                                   │
  └───────────────────────────┬───────────────────────────────────┘
                              │ chunk vectors
  ┌─ Storage ─────────────────▼───────────────────────────────────┐
  │  agents.chunks (one row per chunk)                            │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in. You've shipped RAG, so you've felt that retrieval quality hinges on chunk shape — too big and the relevant sentence is diluted by noise; too small and it loses context. This file is honest about a real limitation: buffr gets aptkit's **fixed-size, 512-char / 64-overlap, character-based** splitter, full stop. It is *not* token-aware, *not* sentence-aware, *not* structure-aware — and buffr can't tune it without changing aptkit (which it never edits). So it cuts mid-sentence and mid-markdown-heading. The concept is exercised; it's just the default, untuned. The Case-B move is to fix it *above* aptkit (pre-chunk) or *in* aptkit (contribute a structural splitter).

## Structure pass

Read the skeleton: chunking is one function, but the *strategy* axis is where the limitation lives.

**Layers:** the file (one string) → the chunker (the cut) → the chunks (retrieval units).

**Axis traced — "what boundary does the cut respect?"**

```
  one axis: what does a chunk boundary align to?

  ┌─ what buffr HAS ────────┐   CHARACTER COUNT — cut at every 448 chars
  │  fixed 512/64 char window│  (512−64 step), ignoring words/sentences
  └────────────┬────────────┘
               │ seam: this is the only knob, and buffr can't turn it
  ┌─ what it COULD respect ─┐   SENTENCE — cut at "." boundaries
  │  sentence / structural   │   STRUCTURAL — cut at markdown headings
  └─────────────────────────┘   (semantic units, not arbitrary offsets)
```

**The seam that matters:** the boundary between "character offset" and "semantic unit." buffr's chunker cuts on the former — a hard offset every 448 characters — so a markdown heading, a code block, or a sentence gets sliced wherever the counter lands. The overlap (64 chars) softens it but doesn't fix it. And the seam is *closed to buffr*: the chunker lives in aptkit, which buffr consumes and never edits. Hold that: the limitation isn't a bug, it's an inherited default buffr can only route around, not tune in place.

## How it works

### Move 1 — the mental model

You know how `String.prototype.slice(start, end)` cuts a string at exact indices, blind to what's there — it'll split a word in half without a second thought? buffr's chunker is a sliding `slice` over the document: take 512 chars, step forward 448, take the next 512, and let consecutive windows overlap by 64 so a fact straddling a boundary survives in at least one window.

```
  the chunker kernel — a sliding fixed-size window

  document:  ┌───────────────────────────────────────────────┐
             │ ...the passport renewal form requires two...   │
             └───────────────────────────────────────────────┘
  window 0:  [════════ 512 chars ════════]
  window 1:              [════════ 512 chars ════════]
                         └64┘ overlap (carries straddling facts)
  window 2:                          [════════ 512 ...
             step = 512 − 64 = 448 chars between window starts

  blind to: sentence ends, headings, code fences — cuts wherever it lands
```

The kernel: a fixed window size + a step (size − overlap) + the overlap that keeps boundary-straddling text. Lose the overlap and a fact split across two windows is lost from both. Lose the fixed size and you don't have *this* strategy — you'd have sentence or structural chunking, which buffr doesn't get.

### Move 2 — the step-by-step walkthrough

**Step 1 — the cut is a character slide, with two constants.** aptkit's `chunkText` is the entire strategy. Two exported constants set it; nothing in buffr overrides them:

```ts
// aptkit packages/retrieval/src/chunker.ts:13-14
export const CHUNK_SIZE = 512;      // chars, NOT tokens
export const CHUNK_OVERLAP = 64;    // chars carried between windows
```

512 *characters* — not tokens. That distinction matters: a token-based chunker (what most production RAG uses) would respect the embedder's actual unit and keep chunks at a consistent semantic length. Character count is a rougher proxy — 512 chars is roughly 100–130 English tokens, but it varies with the text. aptkit chose chars for determinism and zero tokenizer dependency (the comment at `:1-12` says exactly this). It's a reasonable *default*; it's not a tuned choice for buffr's markdown.

**Step 2 — the slide loop.** The window walks the string in steps of `size − overlap`, slicing each window and stopping when it reaches the end:

```ts
// aptkit packages/retrieval/src/chunker.ts:16-31
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length === 0) return [];           // empty doc → no chunks
  if (text.length <= size) return [text];     // short doc → one chunk, no cutting

  const step = Math.max(1, size - overlap);   // 448; the slide distance
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));   // raw slice — blind to content
    if (start + size >= text.length) break;          // last window reached → stop
  }
  return chunks;
}
```

Walk it on a 1200-char doc: window 0 = `[0,512)`, window 1 = `[448,960)`, window 2 = `[896,1200)` (the `break` fires since `896+512 ≥ 1200`). Three chunks, each overlapping its neighbor by 64. The `text.slice(start, start + size)` is the load-bearing line — and it's a raw slice. A markdown heading at char 500 gets split: its last 12 chars are at the tail of window 0, its first chars at the head of window 1. Neither chunk contains the clean heading.

```
  Execution trace — chunkText on a 1200-char markdown doc

  step = 448
  start=0:    slice(0, 512)    → chunk #0   (cuts mid-sentence at 512)
  start=448:  slice(448, 960)  → chunk #1   (overlaps #0 by 64)
  start=896:  slice(896, 1200) → chunk #2   ; 896+512 ≥ 1200 → break
  result: ["...", "...", "..."]  (3 chunks)
  note: a "## Heading" near char 500 is split across #0 and #1
```

**Step 3 — chunks become retrieval units, each embedded whole.** Back in the pipeline, each chunk string is embedded and stored under `"<docId>#<i>"`. The chunk *is* the unit retrieval returns — so its quality bounds everything downstream:

```ts
// aptkit packages/retrieval/src/pipeline.ts:37-44
const texts = chunkText(doc.text);            // the fixed-window cut
const vectors = await wiring.embedder.embed(texts);
const chunks = texts.map((text, i) => ({ id: `${doc.id}#${i}`, vector: vectors[i]!, meta: {..., text} }));
```

Here's the concrete consequence of a bad cut: if the chunk that answers a question got split mid-sentence, *neither* half embeds to a clean vector for that question. The query "what does passport renewal require?" might match a chunk that ends `...renewal form requires` — cut off right before the answer. The 64-char overlap is the mitigation, but it only spans 64 chars; a fact split by more than that is degraded in both chunks.

```
  Layers-and-hops — chunking's effect on retrieval

  ┌─ index ──────┐ hop 1: chunkText (fixed window)  ┌─ embed ─────────┐
  │ doc.text     │ ───────────────────────────────► │ each chunk → vec│
  └──────────────┘  (may cut mid-sentence)           └────────┬────────┘
                                                              │ hop 2: upsert
  ┌─ query ──────┐ hop 3: embed question              ┌─ storage ▼──────┐
  │ "renewal?"   │ ───────────────────────────────►   │ ANN over chunks │
  └──────▲───────┘ hop 4: top-k chunks ◄───────────── │ (bad cut = bad  │
         │          a mid-sentence chunk scores worse  │  match)         │
         └──────────────────────────────────────────── └─────────────────┘
```

#### Move 2.5 — current state vs the tuned chunker you'd want

buffr runs the fixed window today because it can't reach into aptkit. Here's the honest comparison and the two routes out:

```
  Comparison — inherited default vs what you'd build

  TODAY (aptkit default)            BETTER (Case-B routes)
  ┌──────────────────────────┐      ┌──────────────────────────┐
  │ fixed 512/64 CHAR window  │      │ structural: split on      │
  │ char-based (not tokens)   │      │  markdown headings/blocks │
  │ cuts mid-sentence/heading │      │ OR token-based windows    │
  │ buffr CAN'T tune it       │      │ (respect embedder units)  │
  └──────────────────────────┘      └──────────────────────────┘
   Route A: contribute a structural chunker UPSTREAM to aptkit
   Route B: PRE-CHUNK in buffr (split markdown by heading before
            pipeline.index, so each "doc" is already a clean unit)
```

Route B is the buffr-only move: it never touches aptkit. You split the markdown by `##` headings *before* calling `indexDocumentRow`, indexing each section as its own document. aptkit's char window then only acts *within* a clean section, so the worst cuts (across headings) never happen.

### Move 3 — the principle

The chunk is the atom of retrieval — you can only ever retrieve a whole chunk, never a fragment — so chunk boundaries are a quality decision, not a formatting detail. A character-offset cut optimizes for determinism and simplicity; it pays for that with boundaries that ignore meaning. When the splitter is owned by a dependency you don't edit, the leverage you have is *what you feed it*: pre-segment along real boundaries so the dumb window only ever cuts inside already-coherent units. The general lesson: when you can't change a transform, change its input.

## Primary diagram

The chunking strategy, with its limit and the way out, one frame:

```
  buffr chunking — inherited fixed window (and the route around it)

  file.md (one string)
     │ aptkit chunkText (buffr can't tune)
     ▼
  ┌─ fixed-size CHARACTER window ─────────────────────────────────┐
  │  size=512  overlap=64  step=448                               │
  │  slice(start, start+512); slide by 448; break at end          │
  │  ⚠ cuts mid-sentence, mid-heading, mid-code-block             │
  │  ✓ 64-char overlap rescues facts straddling a boundary (<64)  │
  └───────────────────────────┬───────────────────────────────────┘
                              │ chunk = the retrieval atom
                              ▼
  embed each → agents.chunks → ANN retrieval (quality bounded by the cut)

  Case-B fix:  pre-split markdown by heading IN buffr  → each section a
               clean "doc" → char window only cuts inside coherent units
```

## Elaborate

Chunking strategies form a ladder of increasing structure-awareness. *Fixed-size* (buffr's) is the bottom rung: cut every N characters or tokens, optionally overlapping — dead simple, content-blind. *Sentence-based* splits on sentence boundaries so a chunk is always whole sentences. *Recursive/structural* splits along a document's own hierarchy (markdown headings → paragraphs → sentences), falling back down the levels only when a unit exceeds the size budget — this is what production RAG (LangChain's `RecursiveCharacterTextSplitter`, LlamaIndex's node parsers) typically uses for markdown.

aptkit deliberately picked the bottom rung for good reasons stated in its own comment (`chunker.ts:1-12`): deterministic, vendor-neutral, trivially testable — the right *default* for a from-scratch in-memory pipeline. The honest read for buffr: it's a sensible default that buffr hasn't outgrown yet at its tiny corpus size, but it's the first thing to fix when retrieval quality matters, and the fix has to respect that buffr never edits aptkit. Token-based chunking (counting the embedder's actual tokens, not chars) is the other axis of improvement — it keeps chunks at a consistent semantic length regardless of how dense the text is.

## Project exercises

> No `aieng-curriculum.md` is present in this repo, so Build-item IDs are not cited. Exercises are derived directly from the codebase and the spec's concept set.

### Pre-chunk markdown by heading (the buffr-only fix)

- **Exercise ID:** CHK-1 (Case B — fix above aptkit, no aptkit edit).
- **What to build:** before calling `indexDocumentRow`, split a markdown file on `##`/`###` headings into sections, and index each section as its own document (`id = "file.md#section-slug"`). aptkit's char window then only cuts *within* a coherent section — never across a heading.
- **Why it earns its place:** it's the honest, in-bounds fix (buffr never edits aptkit) and directly removes the worst cut (across headings); it also demonstrates "change the input when you can't change the transform."
- **Files to touch:** `src/cli/index-cmd.ts:22-26` (split before the loop) and `src/runtime.ts:5-18` (one document per section); chunker stays untouched at aptkit `chunker.ts`.
- **Done when:** indexing a multi-heading markdown file produces chunks that never span two headings, verified by inspecting `agents.chunks.content`.
- **Estimated effort:** half a day.

### Measure the chunking change with precision@k

- **Exercise ID:** CHK-2 (Case B — prove the chunker change helps).
- **What to build:** a before/after eval: index the same corpus with the raw char window vs the heading-pre-split, run the same query set through the pipeline, and compare precision@k. The chunking change must *earn* its place with a number.
- **Why it earns its place:** "I changed chunking and retrieval improved by X" is the only defensible way to argue a retrieval change; intuition isn't evidence.
- **Files to touch:** the eval path (`src/cli/eval-cmd.ts` per the RAG file's note), run against the two index variants from CHK-1.
- **Done when:** you have a precision@k delta for both chunking strategies over the same query set.
- **Estimated effort:** half a day. Cross-link `../05-evals-and-observability/`.

## Interview defense

**Q: What chunking strategy does buffr use, and what's wrong with it?**
Answer: a fixed-size *character* window — 512 chars, 64 overlap, sliding by 448 — inherited from aptkit's `chunkText`. It's deterministic and tokenizer-free, but it's content-blind: it cuts mid-sentence and mid-markdown-heading, so the chunk that answers a question can get split with the answer straddling two chunks. The 64-char overlap only rescues facts that straddle by less than 64 chars. It's character-based, not token-based, so chunk semantic-length varies with text density.

```
  fixed 512-char window:  [════512════][════512════]  step 448
  cut lands here ─────────────────────┘ mid-sentence, mid-heading
  overlap 64 = only mitigation; >64 straddle = degraded in both chunks
```

**Q: buffr can't edit aptkit — so how would you improve chunking?**
Answer: change the input, since I can't change the transform. Pre-split the markdown by heading *in buffr* before indexing, so each section is its own document and aptkit's char window only ever cuts inside an already-coherent section — the worst boundary (across headings) never occurs. The upstream alternative is contributing a structural/token-based splitter to aptkit, but the in-bounds move is pre-chunking. The anchor: **the load-bearing part people forget is that the chunk is the retrieval atom — you can't retrieve a fragment, so the cut boundary IS a quality decision.**

```
  can't tune aptkit's chunker → pre-segment its INPUT instead
  markdown ─split by heading─► clean sections ─► char window cuts safely
```

## See also

- `01-embeddings.md` — each chunk becomes one 768-vector; a bad cut = a muddy vector.
- `10-incremental-indexing.md` — chunk ids `"<docId>#<i>"` and how re-chunking re-indexes.
- `07-reranking.md` — another quality lever (rerank the chunks the window produced).
- `../05-evals-and-observability/` — measuring whether a chunking change actually helps.

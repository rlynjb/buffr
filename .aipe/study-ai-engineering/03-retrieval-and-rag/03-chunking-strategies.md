# Chunking Strategies

### *industry: document chunking / text splitting · type: the pre-embedding decision that bounds retrieval quality*

## Zoom out

One layer up from embeddings. Before any text becomes a vector, something decides *what counts as one unit of text*. That decision is chunking, and it silently caps how good retrieval can ever be — you can't retrieve a passage you never made into a chunk.

**buffr's retrieval stack, the splitter marked**

```
┌──────────────────────────────────────────────────────────────┐
│  PgVectorStore          search over per-chunk vectors          │
├──────────────────────────────────────────────────────────────┤
│  embeddings             each chunk → one 768-dim vector        │
├──────────────────────────────────────────────────────────────┤
│  ★ CHUNKER ★            512-char windows, 64 overlap (fixed)   │  ◄── this file
├──────────────────────────────────────────────────────────────┤
│  documents              raw markdown text                      │
└──────────────────────────────────────────────────────────────┘
```

On your last RAG app you probably reached for a library splitter and moved on. buffr does the opposite — it owns a deliberately dumb splitter, and the dumbness is a stated design choice, not laziness. This file is about *why a boring splitter can be the right call*, and exactly where it stops being right.

## Structure pass

The axis is **boundary policy**: where you cut one chunk from the next. The seam is the unit you cut on — characters, tokens, sentences, or structure.

**The chunking spectrum, buffr's pick marked**

```
   dumber / cheaper                              smarter / costlier
   ◄──────────────────────────────────────────────────────────►
   fixed-char        fixed-token      sentence        structural
   │                 │                │               (headings,
   │ ★ buffr ★       │ needs a        │ needs an NLP   markdown
   │ 512c + 64 ovl   │ tokenizer dep  │ sentence       sections)
   │ deterministic   │ model-specific │ splitter       │ semantic,
   │ vendor-neutral  │                │                │ heavy
   └─ no deps        └────────────────┴───────────────┴─ best recall
        ▲                                                  on prose
   the seam: do you cut on bytes, or on meaning?
```

To the left of the seam: cuts are mechanical, deterministic, dependency-free, and *blind to meaning*. To the right: cuts respect sentences and sections, retrieve better on prose, and drag in tokenizers or NLP and non-determinism. Consequence: buffr's choice trades a slice of retrieval quality for *zero dependencies and perfectly reproducible chunks* — a trade it makes on purpose and admits to.

## How it works

### Move 1 — Mental model: a fixed-width sliding window with a sticky edge

Picture a 512-character-wide window sliding down the document in steps. Each stop is a chunk. The window doesn't slide a full 512 each time — it backs up 64 characters, so consecutive chunks share an overlapping tail. That overlap is the only "smart" thing here, and it exists for one reason: a fact sitting on a boundary survives in at least one chunk.

**The sliding window with overlap**

```
  document:  [................................................]
             │←──── 512 ────→│
  chunk 0    [################]
                      step = 512 - 64 = 448
                          │←──── 512 ────→│
  chunk 1            [oo################]
                     └ 64-char overlap (shared tail of chunk 0)
                                  │←──── 512 ────→│
  chunk 2                    [oo################]
   a fact straddling a cut lands WHOLE inside at least one window
```

Frontend bridge: it's a windowed scroll with a fixed row height and a small `overflow` bleed between pages, so a line that lands on a page break still renders fully on the next page. No content gets clipped at a seam.

### Move 2 — Walk the mechanism

**Part A — Fixed-size character windows**

The splitter cuts on character count, full stop. No tokenizer, no sentence detection. `CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64`.

**The cut logic**

```
  text.length <= 512 ?  ──► return [text]   (one chunk, done)
        │ no
        ▼
  step = max(1, 512 - 64) = 448
  for start = 0, 448, 896, …:
      push text.slice(start, start + 512)
      if start + 512 >= length: break
```

```ts
// aptkit chunker.ts:16-31 — the whole splitter
export function chunkText(text, size = 512, overlap = 64): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];
  const step = Math.max(1, size - overlap);     // 448
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
```

There is no cleverness to misread. `slice(start, start + 512)` cuts mid-word, mid-sentence, mid-anything. That's the honest cost: a chunk can begin `"…and the answer is"` and end mid-thought. The bet is that 512 chars (~one paragraph) usually contains enough surrounding context that the embedding still lands near the right meaning — and the overlap covers the boundary case.

**Part B — Overlap stops boundary-straddling facts from being lost**

Without overlap, a fact split exactly across a cut would be half in chunk N and half in chunk N+1 — weakened in both, retrievable from neither. The 64-char overlap means the shared tail carries the whole fact into the next window.

**With vs. without overlap**

```
  NO OVERLAP                        64-CHAR OVERLAP
  ──────────                        ───────────────
  …take my cof│fee black…           …take my cof│
  chunk N ─────┘                    chunk N: …take my coffee black…  ✓ whole
            chunk N+1                chunk N+1: …my coffee black, no…  ✓ also whole
  "coffee black" split ──►           the fact survives in at least one chunk
  weak in both, missed
```

```ts
// aptkit chunker.ts:1-12 — the stated rationale (verbatim from the doc comment)
// "The overlap stops a fact that straddles a boundary from being split across
//  two chunks and lost."
```

Overlap is cheap insurance: it costs a little duplicate storage and a few redundant vectors, and it buys you immunity to the worst failure mode of fixed-size chunking. It's the one place the dumb splitter spends complexity, and it spends it where the failure is most likely.

### Move 2.5 — Current vs. future

**Honest: buffr's chunker is NOT sentence/structural/token-aware, and it was NEVER tuned against the eval set.**

```
  TODAY (deliberate, untuned)        SMARTER (a later drop-in)
  ───────────────────────────        ─────────────────────────
  fixed 512-char windows             structural: split on markdown
  cuts mid-word, mid-sentence        headings/paragraphs
  deterministic, zero deps           semantic: keep whole sentences,
  512/64 = round defaults,           recursive split on natural breaks
  never swept for best recall        better recall on prose, needs deps
  ┌──────────────────┐               ┌──────────────────────────┐
  │ chunkText()      │               │ same RetrievalDocument    │
  │ contract: text → │  ──drop-in──► │ contract above it doesn't │
  │ string[]         │               │ change                    │
  └──────────────────┘               └──────────────────────────┘
```

Two honest admissions. First, this is *fixed-size by character* — not by token (no tokenizer dependency, by design) and not by sentence or markdown structure. Second, `512` and `64` are clean round defaults that were **never tuned against `eval/queries.json`** — nobody swept chunk size and measured P@1/R@3 to pick them. The contract (`text → string[]`) is narrow enough that a smarter splitter drops in without touching anything above it. The dumb version is the *honest default*, not the *measured optimum*.

### Move 3 — The principle

**Chunking sets the ceiling on retrieval, so the right first move is the simplest splitter that's deterministic and dependency-free — then measure before you make it smarter.** buffr's fixed-512 splitter is a defensible *starting* point precisely because it's reproducible and owns no dependencies; you can reason about it exactly. The trap is shipping a fancy semantic splitter you can't reproduce and never measured. Dumb-but-known beats clever-but-unmeasured until the eval set tells you the chunking is the bottleneck.

## Primary diagram

The full split, from raw doc to stored chunks.

**One document, N overlapping chunks, N vectors**

```
  documents.content  (raw markdown)
            │
            ▼  chunkText(text, 512, 64)
  ┌──────────┬──────────┬──────────┬──────────┐
  │ chunk 0  │ chunk 1  │ chunk 2  │ chunk 3  │   step = 448, overlap = 64
  └──────────┴──────────┴──────────┴──────────┘
       │          │          │          │
       ▼ embed    ▼          ▼          ▼
  [768]      [768]      [768]      [768]
       │          │          │          │
       ▼          ▼          ▼          ▼
  agents.chunks  id = "<docId>#0", "<docId>#1", …
                 meta = { docId, chunkIndex, text }
```

After the box: each chunk becomes one stored vector with a stable `"<docId>#<i>"` id — so a retrieval hit can always cite which doc and which slice it came from. Chunk granularity *is* citation granularity.

## Elaborate

- **Why character, not token.** A token splitter needs a tokenizer that matches the embedding model, which is a dependency and a coupling. Character count is universal and free. The cost: 512 chars isn't a fixed token count (varies with content), so a chunk's token footprint wobbles. For buffr's small model and short docs, that wobble is harmless.
- **Chunk size is a two-sided dial.** Too small and a chunk loses the context that makes it meaningful (a bare sentence embeds ambiguously). Too large and one chunk covers multiple topics, blurring its direction and re-creating lost-in-the-middle *inside* a chunk. 512 is a middle-of-the-road guess, not a tuned value.
- **Determinism is a testing asset.** Because `chunkText` is pure and deterministic, buffr's pipeline tests can assert exact chunk boundaries without a live model. A non-deterministic semantic splitter would make those tests fuzzy.
- **The contract is the escape hatch.** Everything above chunking consumes `string[]`. Swapping in a recursive/semantic splitter is a local change with no ripple — which is *why* it's safe to ship the dumb version first.

## Project exercises

### Sweep chunk size against the eval set

- **Exercise ID:** [B2A.5] (cite [C2.2], Phase 2A) — Case A: chunking is implemented but admittedly untuned. This turns the round defaults into measured ones.
- **What to build:** Re-index the corpus at several `(size, overlap)` settings — e.g. (256,32), (512,64), (1024,128) — and run `eval-cmd` at each to chart P@1/R@3 vs. chunk size. Pick the setting your eval actually prefers.
- **Why it earns its place:** The file admits 512/64 were never swept. This is the cheapest possible quality win: the splitter contract is one function, the eval already exists, and the answer is currently *unknown*.
- **Files to touch:** drive `chunkText`'s `size`/`overlap` (thread params through `src/cli/index-cmd.ts` indexing), then `src/cli/eval-cmd.ts` to score each.
- **Done when:** A table shows P@1/R@3 across at least three chunk sizes and you can defend the chosen size with numbers.
- **Estimated effort:** 1–4hr.

### Add a structural (markdown-aware) splitter behind the same contract

- **Exercise ID:** [B2B.1] (cite [C2.2], Phase 2B) — Case B: buffr has NO structural chunking. This is the primary target for the "smarter splitter" gap.
- **What to build:** A splitter that cuts on markdown headings/paragraphs (keeping whole sections when they fit, falling back to the 512-window when they don't), exposed behind the same `text → string[]` contract. A/B it against fixed-512 on the eval.
- **Why it earns its place:** buffr's corpus is markdown (work.md/stack.md/coffee.md) — structure-aware cuts should beat byte-blind cuts on exactly this shape of doc. The contract makes it a clean drop-in, and the eval makes the win provable.
- **Files to touch:** a new splitter module consumed by the pipeline's chunk step (aptkit-side seam; buffr wires it via `src/cli/index-cmd.ts`), verified with `src/cli/eval-cmd.ts`.
- **Done when:** The structural splitter is selectable and the eval shows whether it beats fixed-512 on buffr's markdown corpus.
- **Estimated effort:** 1 day.

## Interview defense

**Q: "Why is buffr's chunker so simple?"**

Deliberate. Fixed 512-char windows with 64 overlap are deterministic and dependency-free — no tokenizer, no NLP. It's the honest default: reproducible and easy to reason about. The overlap covers the one real failure of fixed cuts, boundary-straddling facts.

```
  512-char window, step 448
  overlap 64 ──► fact on a cut survives whole in one chunk
```

Anchor: *"Dumb-but-known beats clever-but-unmeasured."*

**Q: "What's wrong with it, honestly?"**

It cuts mid-sentence and was never tuned against the eval set — 512/64 are round guesses, not measured optima. On markdown prose a structural splitter would likely retrieve better. The contract is one function, so that's a clean drop-in.

```
  fixed-char ──► cuts blind to meaning
  fix: structural splitter, same string[] contract
```

Anchor: *"The splitter sets the ceiling — measure it before trusting it."*

## See also

- `./01-embeddings.md` — each chunk becomes one vector; chunk size shapes that vector's direction.
- `../02-context-and-prompts/02-lost-in-the-middle.md` — chunk size also bounds window footprint; a too-big chunk has its own internal middle.
- `./11-rag.md` — where chunks turn into citations; chunk granularity is citation granularity.
- `../05-evals-and-observability/` — the eval set that should drive chunk-size tuning.

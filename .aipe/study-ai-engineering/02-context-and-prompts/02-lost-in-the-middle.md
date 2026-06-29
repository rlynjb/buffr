# Lost in the Middle

**Industry name(s):** lost-in-the-middle · positional attention bias · primacy/recency in context · U-shaped retrieval.
**Type:** Industry standard.

---

## Zoom out, then zoom in

Once your text fits the window (that's the previous file), there's a second problem: the model doesn't read all of it equally. Where you put a fact inside the prompt changes whether the model uses it.

```
  Zoom out — where positioning bites

  ┌─ Session layer (buffr) ──────────────────────────────────┐
  │ RagQueryAgent constructor assembles the system string:   │
  │   [ profile (me.md) ]  ← injected at position 'start'    │ ★
  │   [ template / instructions ]                            │
  │   ... then at query time ...                             │
  │   [ retrieved chunks ]  ← order = retrieval order        │ ★
  │   [ the question ]      ← naturally at the end            │
  └───────────────────────────────┬──────────────────────────┘
                                  │ one flat string → complete()
  ┌─ Model layer (Ollama) ────────▼──────────────────────────┐
  │ gemma2:9b — attends strongly to START and END,           │
  │             skims the MIDDLE                              │
  └───────────────────────────────────────────────────────────┘
```

The two `★` boxes are where buffr's positioning is decided — and notice it's decided *implicitly*. The concept: **models recall information at the start and end of the context far more reliably than information buried in the middle.** Long-context retrieval studies plot accuracy against position and get a **U-shape** — high at the edges, sagging in the middle. The question this answers: **if the answer is in chunk #3 of 8, will the model actually use it?** Often, no — not because it ran out of window, but because chunk #3 landed in the dead zone.

You know this from UX already: the **F-pattern / above-the-fold** reading behavior. Users read the top, skim the middle, glance at the bottom. The model does the same thing to your prompt.

---

## The structure pass

The skeleton here is just the prompt itself, read as ordered positions:

```
  One axis traced across prompt positions

  axis = "how reliably will the model use a fact placed here?"

  ┌─ position: START ─────────────┐  → HIGH  (primacy)
  │ profile, top instructions     │
  └───────────────┬───────────────┘
       seam: the attention sag begins
  ┌───────────────▼───────────────┐  → LOW   (the dead zone)
  │ middle chunks (#2 … #n−1)     │
  └───────────────┬───────────────┘
       seam: attention recovers near the tail
  ┌───────────────▼───────────────┐  → HIGH  (recency)
  │ last chunk + the question     │
  └───────────────────────────────┘
```

**One axis — how reliably will the model use a fact placed here?** Hold that question still and slide down the prompt. The answer is high, then low, then high — and the *flips* are the seams. There's no code at these seams; they're a property of the model's attention, not of buffr. That's the honest core of this file: **buffr does not have a component that owns chunk ordering.** The "structure" is the model's bias, and buffr's relationship to it is incidental, not engineered.

Two things buffr does that *happen* to help, and one it doesn't:
- It injects the profile at `'start'` — lands in the high-recall zone (by aptkit's choice, not buffr's tuning).
- It retrieves few chunks (`minTopK: 4`) — a short list has a small middle, so less can get lost there.
- It does **not** reorder chunks by score — they go in retrieval order, so the strongest chunk can land in the sag. That's the gap.

---

## How it works

#### Move 1 — the mental model

Think of the prompt like a long form where the model fills in answers from memory: it remembers the first field and the last field clearly, and gets fuzzy on the dozen in the middle. The strategy that fights this in one sentence: **keep the list short so there's barely a middle, and put what matters most at the edges.**

```
  Pattern — the U-shaped recall curve

  recall
   high │█                                   █
        │ █                                 █
        │  █                               █
        │   ██                           ██
    low │     ████████████████████████████
        └──────────────────────────────────► position
        start        middle (the sag)      end

  fact at start or end → likely used
  fact in the middle    → likely ignored
```

buffr's mitigations don't bend this curve — they keep your important text off the bottom of it.

#### Move 2 — the step-by-step walkthrough

**The profile goes at the start — high-recall zone.** When `RagQueryAgent` is built, the profile (`me.md`) is injected at `position: 'start'` under a heading, *then* the template renders. So "About the person you are assisting" sits at the very top of the system prompt, in the primacy zone.

```ts
// packages/agents/rag-query/src/rag-query-agent.ts:52-59
constructor(private readonly options: RagQueryAgentOptions) {
  const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
  const withProfile = options.profile
    ? injectProfile(template, options.profile,
        { position: 'start', heading: PROFILE_HEADING })   // ← top of the prompt
    : template;
  this.system = renderPromptTemplate(withProfile, {});      // ← built ONCE
}
```

```
  Where the profile lands in the system string

  ┌─ system prompt ───────────────────────────┐
  │ # About the person you are assisting       │ ◄ position:'start'
  │ <me.md content>                            │   = primacy zone
  │                                            │
  │ You are a personal knowledge assistant…    │ ◄ template below it
  └────────────────────────────────────────────┘
```

The honest read: this is a *good* placement, but it's aptkit's default `'start'`, not a position buffr chose after thinking about lost-in-the-middle. buffr benefits from it without owning the decision. The boundary condition: the system prompt is built *once* in the constructor (`this.system = …`), so the profile's position is fixed for the session — you can't reposition it per turn.

**Retrieve few chunks — a short list has a small middle.** The other implicit mitigation lives in how the search tool is configured: `minTopK: 4`. Pull back 4 chunks instead of 20 and the "middle" is one or two passages, not fifteen — so there's far less surface area for a fact to get lost in.

```ts
// src/session.ts:43
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
```

```
  Few chunks → almost no dead zone

  4 chunks:   [#1 start][#2 mid][#3 mid][#4 end]
                edge      sag      sag    edge
              → only ~2 in the sag

  20 chunks:  [#1]…………………[#10 deep middle]…………………[#20]
              → ~18 in the sag, the answer probably one of them
```

This is a retrieval-quality decision (`03-retrieval-and-rag/`) doing double duty: precise retrieval means you *can* keep the list short, and a short list dodges the middle. The boundary condition: `minTopK` is a *floor*, not a cap — if retrieval returns more, the middle grows back.

**What's missing — score ordering.** Here's the gap stated plainly. The chunks enter the prompt in whatever order retrieval returned them. buffr does **not** reorder them so the highest-scoring chunk sits first or last. So the single most relevant passage can land in position #3 of 4 — the worst spot. There is no code to show here *because the code doesn't exist*; that absence is the lesson.

```
  Current vs ideal chunk order

  current (retrieval order):
    [#1 score .81][#2 score .79][#3 score .92][#4 score .77]
                                  ▲ best chunk, in the sag

  ideal (re-sorted for position):
    [.92 best][.81][.77][.79]   ← strongest at the START
    or "sandwich": [.92 best][.79][.77][.81 second-best]
                    edge                          edge
```

#### Move 2.5 — current state vs future state

This concept is **built-but-not-tuned**, so the comparison matters.

```
  Phase A (now)              vs    Phase B (deliberate)
  ┌────────────────────┐           ┌────────────────────────┐
  │ profile @ 'start'  │           │ profile @ 'start'      │
  │  (aptkit default)  │           │  (kept on purpose)     │
  │ minTopK:4 short    │           │ minTopK:4 short        │
  │ chunks: RETRIEVAL  │           │ chunks: RE-SORTED by   │
  │  order (unmanaged) │  ──────►  │  score, best at edges  │
  └────────────────────┘           └────────────────────────┘
  positioning is incidental        positioning is engineered
```

What *doesn't* have to change: the profile placement and the small `minTopK` are already on the right side of the curve. The only real work is **ordering the chunks buffr already retrieves** — a sort on data you already have, no new retrieval, no model change.

#### Move 3 — the principle

**Position is a free variable you usually leave on the floor.** The model's attention is U-shaped whether you plan for it or not, so the only question is whether you *choose* what sits at the edges. Putting the most important text first or last costs nothing — it's a sort — and a short list shrinks the dead zone for free. The cheapest reliability win in prompting is often just reordering text you were already sending.

---

## Primary diagram

The full picture — buffr's positions against the recall curve, with the gap marked.

```
  buffr's prompt against the U-shaped recall curve

  recall: high ┊ profile (me.md) ┊            ┊ question ┊ high
               ┊  @ 'start' ✓    ┊            ┊  @ end ✓ ┊
          low  ┊                 ┊ chunks #2-3┊          ┊
               ┊                 ┊  (the sag) ┊          ┊
               └─────────────────┴────────────┴──────────┘
                 START               MIDDLE        END

  ✓ profile lands in primacy zone   (aptkit default 'start')
  ✓ question lands in recency zone  (naturally last)
  ✗ chunks NOT reordered by score → best chunk can sit in the sag
    (minTopK:4 keeps the sag small, but doesn't eliminate it)
```

---

## Elaborate

**Where this comes from.** The canonical reference is the 2023 "Lost in the Middle" study (Liu et al.), which fed models long contexts with a single relevant passage at varying positions and measured retrieval accuracy. The result was the U-curve: accuracy highest when the answer was at the very start or very end, lowest in the middle — and the effect persisted even in models marketed for long context.

**Why it happens.** Attention plus training distribution. Models see far more examples where the salient content is near the boundaries (instructions up top, the actual question at the end), so they learn to weight the edges. It's a learned bias, not a hard limit — which is why prompt *ordering*, not just prompt *length*, moves the needle.

**The honest framing for buffr.** This file is mostly study. buffr's two helpful behaviors are real but incidental: the `'start'` profile position is aptkit's default, and `minTopK: 4` was chosen for retrieval quality, not for positioning. Neither was tuned against the U-curve. The one deliberate move available — score-ordering the retrieved chunks — is **not implemented**. Saying that out loud is the point; pretending buffr "mitigates lost-in-the-middle" would overstate it.

**What it connects to.** This sits directly on top of `01-context-window.md` — that file is about *fitting*, this one is about *placing*. And the lever lives in `03-retrieval-and-rag/` — the reranking and ordering of retrieved chunks is exactly where the Phase-B fix would go.

---

## Project exercises

> **No curriculum file exists in this repo** (`/Users/rein/Public/buffr/.aipe/`), so these carry no `[Bx.y]` IDs. This concept is **NOT deliberately implemented** (positioning is incidental, chunk ordering is absent), so these are **Case B**: build the mitigation that doesn't exist yet.

### Exercise — Order retrieved chunks by score before they hit the prompt

- **Exercise ID:** LM-B1 (local id; no curriculum)
- **What to build:** Sort the chunks returned by `search_knowledge_base` by their similarity score so the strongest chunk is first (or sandwich: best first, second-best last), before they reach the model.
- **Why it earns its place:** This is the single deliberate lost-in-the-middle mitigation buffr is missing. It operates on data buffr already has (scores come back with the chunks) — no new retrieval, no model change.
- **Files to touch:** `src/session.ts:43` area (the tool wiring / handler result); do the sort on buffr's side, since `@rlynjb/aptkit-core` is never edited.
- **Done when:** chunk order in the prompt is deterministic by score, and you can show the top-scored chunk now sits at an edge position, not the middle.
- **Estimated effort:** 1-4hr

### Exercise — Prove the U-curve on your own knowledge base

- **Exercise ID:** LM-B2 (local id; no curriculum)
- **What to build:** A tiny eval that plants a known fact in chunk position 1, then middle, then last, and asks a question that requires it — measuring whether the answer is correct at each position.
- **Why it earns its place:** Turns "models lose the middle" from a citation into a number measured on `gemma2:9b` with buffr's real prompt shape. Tells you whether ordering even matters for *your* model.
- **Files to touch:** a new test under buffr's eval/test area (alongside the existing precision@k evals referenced in `05-evals-and-observability/`).
- **Done when:** you have a 3-point accuracy-vs-position result for buffr's stack you can point at.
- **Estimated effort:** 1-2 days

---

## Interview defense

**Q: Your RAG answer is wrong even though the right chunk was retrieved and well within the context window. Why?**

Lost-in-the-middle. The chunk was retrieved and it fit — but it landed in the middle of the prompt, where the model's attention sags. Models recall the start and end of the context far better than the middle, so a buried-but-present fact gets ignored. The fix is positional, not retrieval: reorder so the strongest chunk sits at an edge.

```
  retrieved ✓  +  fits window ✓  +  in the middle ✗
       → present but unused
```

**Anchor:** buffr doesn't reorder — chunks enter in retrieval order (`src/session.ts:43`), so the best one can sit in the sag.

---

**Q: What does buffr actually do about positioning today, honestly?**

Two things incidentally, one thing not at all. The profile injects at `'start'` (primacy zone) — but that's aptkit's default, not a tuned choice. `minTopK: 4` keeps the list short, so the middle is small — but that was a retrieval-quality decision. buffr does *not* order chunks by score, so the deliberate mitigation is missing.

```
  ✓ profile @ start (default)   ✓ few chunks (quality)   ✗ no score ordering
```

**Anchor:** `rag-query-agent.ts:52-59` (profile at 'start'); `src/session.ts:43` (`minTopK:4`); no ordering code anywhere.

---

## See also

- `01-context-window.md` — fitting the text (this file is about placing it once it fits).
- `03-prompt-chaining.md` — the third lever: split work so no single prompt is long enough to have a deep middle.
- `03-retrieval-and-rag/11-rag.md` — where chunk ordering / reranking would live.
- `04-agents-and-tool-use/05-agent-memory.md` — recalled memories are more text competing for edge positions.

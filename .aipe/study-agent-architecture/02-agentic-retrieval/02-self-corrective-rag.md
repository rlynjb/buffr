# 02 — Self-Corrective RAG

*Industry standard: **self-corrective / self-reflective RAG** (CRAG, Self-RAG family) —
NOT YET implemented in buffr.*

---

## Zoom out → zoom in

This is rung 2 of agentic retrieval: the agent stops trusting its own search results and
checks them before it answers.

```
  Section B layers — file 02 is the escalation above the implemented floor

  ┌─ Agent loop (Section A) ───────────────────────────────────┐
  │  ┌─ 01 agentic RAG — model calls search 0..4×, then answers┐│  [IMPLEMENTED]
  │  ├─ ★ 02 SELF-CORRECTIVE RAG ★ — grade chunks, retry on miss│  ← YOU ARE HERE
  │  │     "are these chunks actually relevant? grounded?"      ││     [NOT YET]
  │  ├─ 03 routing — pick the right SOURCE per query ───────────┤│  [NOT YET]
  │  └────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘
```

**The honest one sentence: buffr does NOT implement this — there is no relevance grader
between retrieval and generation, and no query-rewrite fallback when the chunks come back
weak.** In agentic RAG (file 01) the model retrieves and then answers from whatever came
back. Self-corrective RAG inserts a checkpoint: *grade the retrieved chunks, and if they're
junk, don't generate from them — rewrite the query or fall back.* The point it teaches is
the one that bites in production: **retrieval success is not answer success.**

---

## Structure pass

Trace ONE axis: **what happens to a bad retrieval.** That is where self-corrective RAG
splits from plain agentic RAG, and it splits at one seam — the grader.

```
  The axis: the path a WEAK retrieval takes

  AGENTIC RAG (buffr today)          SELF-CORRECTIVE RAG (not yet)
  ─────────────────────────          ─────────────────────────────
  retrieve                           retrieve
     │                                  │
     ▼                                  ▼
  (no check)                         ┌─ GRADE: relevant? grounded? ─┐   ◄── SEAM
     │                               │      yes │        no         │       the grader
     ▼                               │          ▼         ▼         │
  generate from whatever             │     generate   rewrite query │
  came back                          │                / fallback /  │
     │                               │                "I don't know"│
     ▼                               └──────────┬───────────────────┘
  answer (may be confidently                    ▼
  wrong on a bad pull)                        answer (refused if ungrounded)
```

The seam is the grader — a step (often a cheap LLM call or a score threshold) that sits
*between* retrieve and generate and can reject the chunks. buffr has no box at that seam.
When buffr's retrieval returns weak chunks, the model generates from them anyway, nudged only
by a prompt line to admit ignorance.

---

## How it works

### Move 1 — the mental model

In AdvntrCue, did you ever get a confident answer built on three chunks that had nothing to
do with the question? That's the failure self-corrective RAG targets. The mental model:
wrap the retrieve step in a `try`-validate-`catch`, where "validate" is the grader and
"catch" is a fallback retrieval.

```
  PATTERN: grade-then-branch around retrieval

  retrieve(query) ──► chunks
        │
        ▼
  grade(chunks, question) ──► verdict
        │
        ├─ RELEVANT  ──────────────► generate(chunks)           (trust them)
        │
        ├─ AMBIGUOUS ──► rewrite query, retrieve again ──► loop (try harder)
        │
        └─ IRRELEVANT ─────────────► refuse / fall back to web  (don't fabricate)
```

The grader is the new organ. Everything else you already have. The discipline is: never let
a generate step run on chunks no one checked.

### Move 2 — step by step

**Part 1 — The grader: a checkpoint between retrieve and generate.**

The grader scores each chunk (or the batch) on two questions: *is this relevant to the
query?* and later *did the answer actually use it (grounded)?* It's typically a small,
fast LLM call or a score cutoff.

```
  Part 1 diagram: where the grader sits (and where buffr's gap is)

  buffr today:   retrieve ───────────────────────────► generate
                          ▲
                          └─ [ NO GRADER HERE — this is the gap ]

  self-corrective: retrieve ──► grade(relevant?) ──► generate
                                    │
                                    └─ if no ──► rewrite / fallback
```

Bridge from known: it's a validation layer on a `fetch()` response — you don't render the
data until you've checked the response is the shape you expected. The grader checks the
*relevance* of the retrieval before the model "renders" an answer from it.

Pseudocode first, since the logic is the lesson:

```
function answerWithCorrection(question):
    chunks = retrieve(question)
    verdict = grade(chunks, question)          # the new step
    if verdict == RELEVANT:
        return generate(question, chunks)
    if verdict == AMBIGUOUS:
        better = rewriteQuery(question)        # the fallback path
        return answerWithCorrection(better)    # bounded recursion
    return "I couldn't ground an answer in the knowledge base."
```

buffr has none of this branch. Its flow is the top line only: `retrieve → generate`.

**Part 2 — What buffr ships instead: two lightweight stand-ins.**

buffr is not naive about bad retrieval — it just defends against it with two cheap
mechanisms instead of a real grader. Worth knowing precisely, because in an interview "we
don't have a grader, but here's the lightweight insurance we do have" is a strong answer.

```
  Part 2 diagram: buffr's two stand-ins for a grader

  STAND-IN 1: the minTopK floor (prevents under-retrieval)
     model asks top_k:1 ──► max(1, 4) = 4 ──► 4 chunks, not 1
     "don't let the model starve its own retrieval"

  STAND-IN 2: the "say so plainly" prompt (prevents fabrication)
     weak chunks ──► model nudged to admit "not in the knowledge base"
     "refuse rather than guess" — a prompt-level grounding check
```

Stand-in 1 — the `minTopK: 4` floor, raising the chunk count so the model has enough
evidence to work with:

```ts
// aptkit/packages/retrieval/src/search-knowledge-base-tool.ts:50-51
const defaultTopK = options.defaultTopK ?? DEFAULT_TOP_K;
const minTopK = Math.max(1, options.minTopK ?? 1);   // buffr passes 4 (session.ts:43)
```

```ts
// aptkit/packages/retrieval/src/search-knowledge-base-tool.ts:80-81
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);       // floor: never fewer than 4 chunks
```

This is *not* a grader — it doesn't check whether the 4 chunks are relevant. It only ensures
the model can't accidentally answer from a single chunk on a multi-part question. It fixes
under-*quantity*, not under-*quality*.

Stand-in 2 — the system prompt's grounding-and-refusal instruction:

```ts
// aptkit/packages/agents/rag-query/src/rag-query-agent.ts:24-27
'passages before answering. Ground every answer in the retrieved chunks and cite',
'their sources. If the knowledge base does not contain the answer, say so plainly',  // ← prompt-level grounding
'rather than guessing.',
```

This pushes the *grounded?* check into the model's own judgment via the prompt, rather than
running a separate grader call. It's free, but it's only as reliable as a 9B model following
instructions — which is exactly why a real grader exists as a separate, deterministic step.

**Part 3 — The fallback path buffr lacks: query rewrite / source escalation.**

When the grader says "irrelevant," self-corrective RAG doesn't just refuse — it can *rewrite
the query* (the original phrasing may have missed) and retrieve again, or escalate to a
different source (web search). buffr has neither.

```
  Part 3 diagram: the fallback ladder buffr does not climb

  weak chunks ──► grade ──► IRRELEVANT
                              │
   buffr today: ─────────────►│ generate anyway, nudged to say "I don't know"
                              │
   self-corrective: ─────────►├─ rewrite query, retrieve again   (buffr: ✗)
                              ├─ escalate to web search           (buffr: ✗ — see file 03)
                              └─ refuse with reason               (buffr: prompt-only)
```

Note the loop already *has* a forced-refusal endpoint — `FALLBACK_ANSWER` at
`rag-query-agent.ts:31` ("I couldn't find anything in the knowledge base to answer that")
fires when the model returns empty. But that's a *last-resort empty-output* catch, not a
*relevance-driven* fallback. The difference: buffr refuses when it produces nothing; a
self-corrective system refuses when it produces something *ungrounded*.

### Move 3 — the principle

**Retrieval success is not answer success.** A vector store will always return its top-k —
even for a query it has nothing relevant to. Self-corrective RAG is the admission that "the
store returned chunks" and "the chunks answer the question" are different facts, and it puts
a grader between them. buffr collapses them today, betting on `minTopK` + a refusal prompt to
hold the line.

---

## Primary diagram (recap)

The gap, framed against what buffr does have.

```
  Self-corrective RAG vs buffr's stand-ins

  FULL SELF-CORRECTIVE RAG (not yet)        BUFFR TODAY (the stand-ins)
  ════════════════════════════════         ═══════════════════════════════════
   retrieve                                  retrieve  (minTopK:4 → ≥4 chunks)  ◄ stand-in 1
      │                                          │
      ▼                                          │  [ no grader ]
   GRADE relevant? ──no──► rewrite/web           │
      │ yes                  │                    ▼
      ▼                      ▼                  generate, prompt-nudged:         ◄ stand-in 2
   generate              retrieve again          "ground every answer,
      │                                           say so plainly if not found"
      ▼                                              │
   GRADE grounded? ──no──► refuse                    ▼
      │ yes                                        answer (refusal is prompt-only,
      ▼                                            empty-output fallback at :31)
   answer
```

buffr's two stand-ins cover the *cheap* failure modes (too few chunks, obvious "not found").
The grader covers the *expensive* one: confidently wrong from plausible-but-irrelevant
chunks. buffr does not cover that yet.

---

## Elaborate

**Why buffr can reasonably skip it (for now).** Self-corrective RAG roughly *doubles* the
model calls — a grader call per retrieval, plus rewrite-and-retry rounds — on top of agentic
RAG's already 3-10× token cost over static. On a local 9B model where each call is slow, that
compounds badly. buffr's domain (a personal knowledge base the user indexed themselves) also
has a friendlier base rate: the store mostly contains things relevant to the user's
questions, so the "confidently wrong from irrelevant chunks" failure is rarer than it would
be over a noisy web corpus. The stand-ins are a defensible bet for this scope.

**When the bet breaks.** The day buffr indexes a large, noisy, or multi-domain corpus — or
serves questions whose answers genuinely aren't in the store — the refusal prompt alone will
let confidently-wrong answers through. That's the trigger to add a real grader. The smallest
honest version: one cheap LLM call after retrieval scoring "do these chunks contain the
answer? yes/no," gating the generate step.

**Where it would slot in.** The clean insertion point is inside the search tool handler
(after `pipeline.query` at `search-knowledge-base-tool.ts:89`) or as a wrapper agent around
`runAgentLoop`. The grader is itself a small agent-loop call — which is why this pattern is
"agentic": the correction is model-driven, not a fixed threshold.

---

## Interview defense

**Q: "Your model retrieves and then answers. What stops it from confidently answering off
irrelevant chunks?"**

> Honestly — not much, by design, yet. buffr has no relevance grader between retrieval and
> generation, which is the textbook self-corrective-RAG checkpoint. What it ships instead is
> two lightweight stand-ins: a `minTopK:4` floor so the model can't starve itself down to one
> chunk, and a system prompt that says "ground every answer in the retrieved chunks, and if
> it's not there, say so plainly rather than guessing." Those cover under-retrieval and
> obvious misses cheaply. They do *not* cover the expensive failure — confidently wrong from
> plausible-but-irrelevant chunks — because the principle is **retrieval success is not
> answer success**, and only a real grader closes that gap. The trigger to add one is a
> noisier corpus; the smallest version is a single yes/no grounding call gating the generate
> step.

```
  The defense in one diagram

  failure mode                          buffr's coverage
  ──────────────────────────────────    ────────────────────────────────
  too few chunks (under-retrieval)  ──► minTopK:4 floor            ✓ covered
  answer obviously not in store     ──► "say so plainly" prompt    ✓ partial (prompt-only)
  confidently wrong from irrelevant ──► [ would need a grader ]    ✗ not yet
       chunks
```

**Anchor it in code:** the absence is the point — there is no grader call in
`run-agent-loop.ts` or `search-knowledge-base-tool.ts`. The stand-ins are real:
`minTopK` at `search-knowledge-base-tool.ts:50-51` and `80-81`, the grounding/refusal prompt
at `rag-query-agent.ts:24-27`, the empty-output fallback at `rag-query-agent.ts:31`.

---

## See also

- `01-agentic-rag.md` — the implemented floor this pattern escalates from; the `minTopK`
  floor is introduced there as a retrieval guardrail and reused here as a grader stand-in.
- `03-retrieval-routing.md` — the *web fallback* mentioned here as an escalation path is
  itself a routing decision; that file covers picking the source.
- `../01-reasoning-patterns/05-reflexion-self-critique.md` — the general self-critique loop;
  self-corrective RAG is that loop specialized to retrieval relevance.
- **`study-ai-engineering`** — reranking and relevance scoring mechanics, which a grader
  builds on. This file does not re-teach them.

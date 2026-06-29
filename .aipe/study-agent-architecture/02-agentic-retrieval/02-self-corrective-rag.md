# Self-corrective RAG — grade the chunks before you trust them

**Industry name(s):** self-corrective RAG · CRAG · relevance-graded
retrieval · retrieve-and-grade. **Type label:** Industry standard.

**In this codebase: Not yet implemented.** buffr retrieves and
generates with no relevance grader between them. The system prompt
*asks* the model to ground answers in the chunks
(`rag-query-agent.js:16-17`), but nothing checks whether the retrieved
chunks are actually relevant before they reach generation. The
`minTopK: 4` floor is the only retrieval-side guard.

## Zoom out, then zoom in

Self-corrective RAG adds one gate to agentic RAG: between retrieval and
generation, grade whether the chunks are relevant and grounded, with a
fallback path when they're not.

```
  Zoom out — the grader sits between retrieve and generate

  ┌─ Agentic retrieval (SECTION B) ──────────────────────────┐
  │  retrieve → ★ GRADE relevance ★ → generate                │ ← we are here
  │                  │ not relevant                          │
  │                  └─► fall back: rewrite / widen / escalate │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the load-bearing distinction is that *retrieval success is not
answer success*. A chunk coming back from cosine search means it was
nearby in vector space — not that it's relevant or that the answer is
grounded in it. The grader is the gate that catches the gap.

## Structure pass

**Layers.** Three: retrieve, grade, generate. buffr has the first and
third; this pattern inserts the middle.

**Axis — "what's checked before generation?"** In buffr: nothing — the
top-k chunks go straight into the answer context. In self-corrective
RAG: each chunk's relevance and the answer's groundedness. That added
check is the pattern.

**Seam.** The retrieve→generate boundary. Today buffr trusts whatever
cosine search returns. The grader makes that boundary a checkpoint with
a fallback, so a bad retrieval doesn't silently become a bad answer.

## How it works

#### Move 1 — the mental model

You wouldn't render API data without checking the response was the
shape you expected. Self-corrective RAG is that validation step for
retrieval: don't generate from chunks you haven't confirmed are
relevant.

```
  Pattern — grade-then-branch

  retrieve → ┌─────────────────────────┐
             │ grade each chunk:       │
             │ relevant? grounded?     │
             └──────────┬──────────────┘
              ┌──────────┴──────────┐
              ▼ relevant            ▼ not relevant
          generate            fall back:
                              rewrite query / widen
                              search / escalate
```

#### Move 2 — the walkthrough (what it would take in buffr)

**Where the gate would go.** buffr's tool returns ranked chunks
straight to the model (`search-knowledge-base-tool.js:41-44`), and the
model is *told* to ground its answer but never made to. A grader would
sit between the tool result and the next model turn: score each chunk
for relevance to the query, and if too few pass, take a fallback
(rewrite the query, widen top-k, or say "not in the knowledge base").

**Why buffr needs this more than a cloud RAG does.** Two reasons
specific to this repo. First, the store is *shared* — documents and
conversation memory both live in `chunks`
(`src/session.ts:50-53`), so a query can pull back a stale past
*exchange* when it wanted a *document*. A grader would catch that
mismatch. Second, Gemma2:9b is a weaker generator than a frontier
model; it's likelier to confabulate from loosely-relevant chunks, so
the "grounded?" check matters more.

**The cheap version buffr already has.** The `minTopK: 4` floor
(`search-knowledge-base-tool.js:32`) is a crude relevance guard — it
guarantees *enough* chunks, not *relevant* ones. And the filter logic
deliberately won't let a hallucinated filter wipe all results
(`matchesFilter`, `search-knowledge-base-tool.js:48-53`). Those are
retrieval-side guards, not a grader — they protect against starvation,
not irrelevance.

```
  Comparison — buffr today vs self-corrective

  buffr today:                     self-corrective (would-be):
    retrieve top-k (min 4)           retrieve top-k
    → straight to generation         → grade each chunk
    (prompt asks for grounding,        ├ enough relevant → generate
     nothing verifies it)             └ not → rewrite / widen / "no answer"
```

#### Move 3 — the principle

Retrieval success (a chunk came back) is not answer success (the chunk
is relevant and the answer is grounded in it). The grader is the gate
that catches that gap. In a system with a shared doc/memory store and a
modest local generator — buffr exactly — that gap is wider than usual,
which makes this the highest-value retrieval upgrade buffr hasn't made.

## Primary diagram

```
  Self-corrective RAG (would-be shape in buffr)

  query → retrieve (top-k, min 4)
              │
              ▼
        ┌─ grade: relevant? grounded? ─┐
        └──────┬───────────────┬────────┘
               ▼ pass          ▼ fail
           generate        rewrite query / widen /
                           "not in knowledge base"
```

## Elaborate

Corrective RAG (CRAG, Yan et al., 2024) added a lightweight retrieval
evaluator that classifies retrieved docs as correct/ambiguous/incorrect
and triggers web-search fallback on failure. The buffr-relevant version
is simpler: a relevance gate that prevents generating from junk. It
composes naturally with the relevance-recall memory model — a grader
would also stop a stale memory chunk from poisoning an answer (see
`04-agent-infrastructure/02-agent-memory-tiers.md`). The
groundedness check is also the natural eval metric — see
`04-agent-infrastructure/04-agent-evaluation.md`.

## Interview defense

**Q: How does buffr guard against retrieving irrelevant chunks?**
Today, barely — there's a `minTopK: 4` floor so the model can't starve
itself, and a filter that won't let a hallucinated filter wipe all
results, but no relevance grader. The system prompt asks for grounding;
nothing verifies it. The highest-value upgrade is a grader between
retrieve and generate, especially because buffr shares one store for
documents and memory, so a query can pull a stale exchange when it
wanted a document.

```
  retrieve → [GATE: relevant?] → generate | fallback
```

**Anchor:** "Retrieval success isn't answer success — buffr has no
grader on that gap yet."

## See also

- `01-agentic-rag.md` — the loop this gate would sit inside
- `03-retrieval-routing.md` — the other retrieval upgrade
- `04-agent-infrastructure/02-agent-memory-tiers.md` — why the shared
  store makes grading more valuable
- `.aipe/study-security/03-indirect-prompt-injection-surface.md` — the
  same shared-store risk from the security angle

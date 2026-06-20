# Grounding and citation instruction

**Industry name(s):** Grounding instruction / citation prompting / abstention prompting · *Industry standard*

---

## Zoom out, then zoom in

A RAG system retrieves passages and asks the model to answer from them.
The instruction that says "answer from these, cite them, and admit when
they don't cover it" is the **grounding contract**. It's the whole
reason RAG beats a bare LLM on factual questions — and on a weak local
model, the contract is doing real work, because Gemma will happily make
something up if you don't pin it to the retrieved text.

```
  Zoom out — where grounding sits in the RAG flow

  ┌─ Service: RagQueryAgent ─────────────────────────────────────┐
  │  system prompt = profile + ★ GROUNDING CONTRACT ★            │
  │                              (this guide)                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ turn 1: model calls search tool
  ┌─ Retrieval: search_knowledge_base ───────────────────────────┐
  │  pgvector top-k → chunks → citations [docId] snippet         │
  └───────────────────────────┬──────────────────────────────────┘
                              │ tool result (the ground truth)
  ┌─ Service: RagQueryAgent ──▼──────────────────────────────────┐
  │  turn 2: model answers, told to cite the [docId]s it got     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is two halves that only work together — an
**instruction** that demands grounding + citation, and a **payload**
that hands the model pre-formatted citations to use. The instruction
without the payload is a wish; the payload without the instruction is
ignored. buffr ships both.

---

## Structure pass

**Layers.** System prompt (the instruction) → retrieval tool (the
citation payload) → final answer (the model's grounded prose).

**Axis — *what is the model trusted to know?*** Trace it:

```
  axis: source of truth at each layer

  ┌─ system prompt ─────┐  "ground in retrieved chunks"  → NOTHING on its own
  └─────────┬───────────┘  (the model is told it knows nothing yet)
  ┌─ tool result ───────┐  [docId] snippet, score        → THE chunks (truth)
  └─────────┬───────────┘
  ┌─ final answer ──────┐  prose citing [docId]s         → only what chunks said
  └─────────────────────┘  (if grounding held)
```

**The seam:** the tool-result boundary. Before it, the model is
instructed to treat itself as knowing nothing relevant. After it, the
retrieved chunks are the only sanctioned source. The grounding
instruction's entire job is to make the model *respect that flip* — to
not leak pre-training knowledge across the seam. On a weak model, that
seam leaks; the instruction is the patch, and it's an unenforced one
(see the honest gap below).

---

## How it works

### Move 1 — the mental model

Think of a `fetch()` that returns `{ loading, data, error }`. The
grounding contract is the prompt-level version of handling all three
states: *data* → answer from it and cite it; *empty* → say so plainly,
don't guess. The "don't guess" branch is the abstention rule, and it's
the one juniors leave out.

```
  The pattern — grounding contract as a 3-branch instruction

                    ┌─ has relevant chunks? ─┐
              yes ──┤                         ├── no
                    ▼                         ▼
        "answer from them              "say so plainly
         AND cite [docId]"              rather than guessing"
                    │                         │
                    └──── never use ──────────┘
                       pre-training facts
                       as if retrieved
```

### Move 2 — the walkthrough

**The instruction text.** `rag-query-agent.js:12-19`, four sentences,
each doing one job:

```
  the four jobs of the BASE_SYSTEM template

  "You are a personal knowledge assistant."        ← identity
  "Always call search_knowledge_base FIRST          ← tool-first
   to retrieve relevant passages before answering"     (no answer w/o retrieval)
  "Ground every answer in the retrieved chunks       ← grounding
   and cite their sources."                              + citation
  "If the KB does not contain the answer,            ← abstention
   say so plainly rather than guessing."               (the branch juniors skip)
```

The "Always call… FIRST" sentence is the bridge to tool-use prompting —
it's what makes the model emit a tool call on turn 1 instead of
answering from pre-training. Without it, a weak model answers
immediately from memory and never retrieves.

**The citation payload.** The instruction says "cite their sources" —
but the model can only cite what it's handed. The tool
(`search-knowledge-base-tool.js:54-63`, `toResult`) pre-formats every
hit:

```
  toResult — manufacturing the citation the prompt asks for

  docId   = hit.meta.docId ?? hit.id            ← stable source id
  text    = hit.meta.text ?? ''
  snippet = text > 160 ? text[:157]+'...' : text ← bounded, won't blow budget
  citation = snippet ? `[${docId}] ${snippet}`  ← the [docId] form the model cites
                     : `[${docId}]`
```

This is the load-bearing half people miss. "Cite your sources" is empty
unless the sources arrive in a citable shape. buffr hands the model
`[coffee.md] I take my coffee black…` — so the model's job is reduced to
copying the `[coffee.md]` tag into its answer, not inventing a citation
format. The snippet cap at 160 chars (`:57`) keeps each citation small
enough that top-k of them fits the budget.

**The minTopK floor.** `ask-cmd.ts:23` creates the tool with
`{ minTopK: 4 }`, and the tool clamps up
(`search-knowledge-base-tool.js:32`, `Math.max(requestedTopK, minTopK)`).
Even if the weak model asks for `top_k: 1`, it gets at least 4 chunks.
Grounding needs enough context to actually contain the answer; a model
under-requesting would starve itself. The floor is a prompt-adjacent
guard against the model misusing its own tool.

### Move 3 — the principle

Grounding is **two halves or nothing**: an instruction that demands it
and a payload shaped to satisfy it. Telling a model to "cite sources"
while handing it raw text with no source tags produces invented
citations. The discipline is to manufacture the citation *in the tool
result*, so the model copies rather than composes. The instruction sets
the rule; the payload makes the rule cheap to follow.

---

## Primary diagram

```
  Grounding + citation — instruction meets payload

  ┌─ System prompt (rag-query-agent.js:12-19) ───────────────────┐
  │  identity · tool-first · GROUND + CITE · abstain             │
  └───────────────────────────┬──────────────────────────────────┘
                              │ turn 1 → tool call
  ┌─ search_knowledge_base (tool) ───────────────────────────────┐
  │  pgvector top-k (≥ minTopK 4, ask-cmd.ts:23)                 │
  │  toResult: citation = `[${docId}] ${snippet}`  (:54-63)      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ tool result: ranked [docId] citations
  ┌─ System prompt + tool results ──▼────────────────────────────┐
  │  turn 2 → model answers, copying [docId] tags it was handed  │
  │  (grounding HELD if it cited; UNENFORCED if it didn't)       │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use case.** `eval/queries.json` is the grounding eval: "how does the
author take their coffee" → relevant doc `coffee.md`. The grounding
contract is what makes buffr answer from the indexed `coffee.md` chunk
and tag it `[coffee.md]`, rather than inventing a generic answer about
coffee from Gemma's pre-training.

**The instruction — `rag-query-agent.js:12-19`:**

```
  DEFAULT_SYSTEM_TEMPLATE  (lines 14-18)

  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to       ← tool-first
   retrieve relevant passages before answering.`,
  `Ground every answer in the retrieved chunks and cite their sources.`,  ← grounding+cite
  `If the knowledge base does not contain the answer, say so plainly      ← abstention
   rather than guessing.`
       │
       └─ buffr passes NO custom prompt (ask-cmd.ts:33), so this default
          ships verbatim — it IS buffr's grounding contract
```

**The payload — `search-knowledge-base-tool.js:54-63`:** `toResult`
builds `` citation: `[${docId}] ${snippet}` `` for every hit — the
citable shape the instruction's "cite their sources" depends on.

**The floor — `ask-cmd.ts:23`:**
`createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 })` — guarantees
at least 4 chunks reach the model so grounding has material to stand on.

**The honest gap.** Nothing checks the answer *contains* a citation.
`run-agent-loop.js:54-56` takes the model's final text as-is. The
grounding contract is instruction-only; an unenforced "please cite." On
a weak model this is a real risk — see lens 2 and lens 6 in
[`audit.md`](audit.md). The buildable fix is a validation pass (the
`structured-generation.js` retry shape, → `04`) or a few-shot example of
a cited answer (→ audit lens 8).

---

## Elaborate

Grounding + abstention is the core of every production RAG system; the
canonical reference is the RAG literature's "answer only from context"
framing and Anthropic's guidance on citation prompting. The abstention
branch ("say so plainly rather than guessing") is the part that survives
production — it's what stops the system from confidently answering
questions outside its corpus, which is the failure mode that erodes user
trust fastest.

The reader has shipped the cousin: AdvntrCue's RAG path grounds GPT-4 in
pgvector hits the same way. The difference buffr exposes is **model
strength**. GPT-4 respects "ground in context" reliably; Gemma 2 9B
needs the contract stated bluntly and the citations pre-formatted,
because it leaks pre-training knowledge across the retrieval seam more
readily. Same pattern, more scaffolding.

What's missing relative to a hardened system: citation *enforcement*
(validate the answer cites something) and *input delimiters* on the
retrieved chunks (so a poisoned chunk can't carry instructions — the
injection-defense gap, audit lens 12). The grounding instruction is
currently the only thing between a malicious document and the model.

---

## Interview defense

**Q: You told the model to cite sources. What makes that actually work
instead of producing hallucinated citations?**

The tool result is pre-formatted into citable shape —
`` `[${docId}] ${snippet}` `` at `search-knowledge-base-tool.js:61`. The
model copies the `[docId]` tag it was handed; it doesn't invent a
format. "Cite your sources" without a citable payload produces made-up
citations every time. The load-bearing part people forget: the
**abstention branch** — "say so plainly rather than guessing"
(`rag-query-agent.js:18`) — without it the model fills gaps from
pre-training and grounding silently fails.

```
  cite-works = instruction  ×  citable payload
  ┌────────────┐    ┌─────────────────┐
  │ "cite       │ ×  │ [docId] snippet │  = model copies a tag
  │  sources"   │    │ pre-formatted   │
  └────────────┘    └─────────────────┘
  instruction alone = invented citations
```

**Anchor:** "Grounding is two halves — the instruction at
`rag-query-agent.js:15` and the citable payload at `toResult:61`."

---

## Validate

- **Reconstruct.** Name the four sentences of the BASE_SYSTEM template
  (`rag-query-agent.js:12-19`) and the one job each does.
- **Explain.** Why does the citation get manufactured in `toResult`
  (`search-knowledge-base-tool.js:61`) instead of the prompt just saying
  "cite the document name"? What breaks if you remove the `[docId]`
  formatting?
- **Apply.** A user reports buffr answered a question its corpus doesn't
  cover, with a confident made-up answer. Which sentence of the contract
  failed, and is the failure in the instruction or in enforcement?
  (`rag-query-agent.js:18` + the unenforced gap in `run-agent-loop.js:54`.)
- **Defend.** Argue whether buffr should add citation *enforcement*
  (reject answers with no `[docId]`) or accept the unenforced contract.
  What's the cost of each on a weak model?

---

## See also

- [`03-tool-call-emulation-prompt.md`](03-tool-call-emulation-prompt.md)
  — how "Always call search FIRST" becomes an actual tool call
- [`05-bounded-synthesis-nudge.md`](05-bounded-synthesis-nudge.md)
  — the final turn where the model answers and cites
- [`study-security/03-indirect-prompt-injection-surface.md`](../study-security/03-indirect-prompt-injection-surface.md)
  — why ungrounded chunk text is a trust boundary

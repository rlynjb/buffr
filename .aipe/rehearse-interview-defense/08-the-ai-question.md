# Chapter 8 — The AI Question

This is the 2026 question every senior interviewer now asks: "Did you
use AI to build this?" And its sharper follow-ups: "Can you explain this
section line by line?" "What did the AI get wrong?" The interviewer
already knows the answer to the first one is yes — that's the default in
2026, and they know it. What they're actually testing is whether you
understand what you shipped well enough to *own it*. The worst possible
answer is defensive or evasive. The best possible answer is grounded:
matter-of-fact about the AI's role, matter-of-fact about your role,
ending with a genuine reflection on what the tools have taught you.

This chapter is the capstone because the AI-honest posture runs through
the whole book. Every "I evaluated and accepted" in chapter 3, every "I
took the default" in the HNSW box — those were practice for this. Here
it gets explicit.

## What AI did, what you did — the split

The anchor for this chapter: an honest split of the work into three
modes of decision-making. This is the frame you carry into the question.

```
  the three modes of decision-making — own all three honestly

  ┌─ DELIBERATE (your call, you'd defend it cold) ──────────────────┐
  │  the library boundary / contracts split                          │
  │  build-vs-Hermes (own the judgment layer)                        │
  │  local-first / privacy-first model choice                        │
  │  the dropped-FK tradeoff (two named reasons)                     │
  │  the Ink/React interface (your domain)                           │
  │  capture-trajectories-now thesis                                 │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ EVALUATED-AND-ACCEPTED (AI suggested, you weighed it) ─────────┐
  │  pgvector over a managed vector DB (weighed colocation)          │
  │  the meta-rebuild shape in the adapter (you verified it)         │
  │  the best-effort memory try/catch (you reasoned the asymmetry)   │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ DEFAULTED-TO (AI's default, you didn't deeply evaluate) ───────┐
  │  HNSW m / ef_construction (pgvector defaults, numbers held)      │
  │  Postgres isolation level (took the default)                     │
  │  the exact chunk-size / overlap in the pipeline                  │
  │      ▲ the riskiest to own — and the most senior-positive        │
  │        when owned WELL                                           │
  └──────────────────────────────────────────────────────────────────┘
```

The third band is the one that matters. Owning a "defaulted-to" decision
honestly — "the AI picked this default, I didn't deeply evaluate it, the
numbers held up, and here's what I'd revisit" — is the single most
senior-signal-positive thing you can do in this chapter.

---

### Question 1 — "Did you use AI to build this?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Did you use AI to build this? Like, how much of it is        │
│    yours?"                                                       │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   NOT whether you used AI — they assume you did. Whether you    │
│   can be matter-of-fact about it without getting defensive,    │
│   and whether "using AI" means you understand the output or    │
│   you copy-pasted it. The defensiveness is the failure.        │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Yeah, heavily — it's 2026, I'd be suspicious of anyone who says they
> didn't. The way I'd frame it: AI was a fast pair-programmer, but the
> decisions were mine and I can defend every one of them. There are three
> modes. Some things were deliberate calls I drove — the library
> boundary, building instead of using Hermes, going local-first. Some
> things AI suggested and I evaluated and accepted — pgvector, for
> instance, it proposed it and I weighed it against a managed vector DB,
> decided colocation was worth more than a specialized engine at my
> scale, and accepted it. And some things were defaults I took without
> deeply evaluating — the HNSW index parameters, I ran pgvector's
> defaults and my retrieval numbers held up, so I didn't go tune them.
> I'm comfortable telling you which bucket any decision is in. The line I
> hold is: I never shipped a line I couldn't explain. If AI wrote
> something I didn't understand, I made myself understand it before it
> stayed."

This is the answer that wins because it's *matter-of-fact* (yes, heavily,
no flinch), it *structures* the AI's role honestly (the three modes),
and it lands the load-bearing principle: never shipped a line you
couldn't explain. That principle is exactly what separates "I understand
what I built" from "I generated something."

```
  ┃ The honest line isn't "I barely used AI." It's "I used it
  ┃ heavily and I never shipped a line I couldn't explain."
  ┃ The second is the one a senior interviewer trusts.
```

#### Weak vs strong — the AI question

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I mostly wrote it myself,  │ "Heavily — it's 2026. AI    │
│ AI just helped with some    │ was a fast pair-programmer; │
│ boilerplate and             │ the decisions were mine. I  │
│ autocomplete here and       │ can tell you which mode any │
│ there."                     │ decision was in: deliberate │
│ — OR —                      │ (the library boundary),     │
│ "AI wrote most of it, I'm   │ evaluated-and-accepted      │
│ not totally sure how the    │ (pgvector over a managed    │
│ retrieval part works         │ DB), or a default I took    │
│ exactly."                   │ (HNSW params). I never      │
│                             │ shipped a line I couldn't   │
│                             │ explain."                   │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ First version: defensive,   │ No defensiveness, no        │
│ minimizing — reads as       │ minimizing, no evasion. The │
│ embarrassed, which signals  │ three-mode structure proves │
│ you think AI use is a       │ you tracked your own        │
│ problem. Second version:    │ decision-making, and "never │
│ the fatal one — you don't   │ shipped a line I couldn't   │
│ understand your own         │ explain" is the exact       │
│ system. Either kills it.    │ ownership claim they want.  │
└─────────────────────────────┴─────────────────────────────┘
```

Both weak versions fail, for opposite reasons. The minimizing one signals
you think AI use is shameful (it isn't, in 2026). The "not sure how it
works" one is the genuinely disqualifying answer — it means you can't own
what you shipped, which is the *only* thing this question is actually
testing.

---

### Question 2 — "Explain this section line by line."

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Pull up the retrieval code. Walk me through this function,   │
│    line by line."                                                │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   The direct ownership test. Can you explain code that AI      │
│   likely helped write, at the line level, including WHY each   │
│   line is there? This is where "I used AI but understand it"   │
│   gets verified or exposed.                                     │
└─────────────────────────────────────────────────────────────────┘
```

This is the moment the whole book has prepared you for. Pick the
`PgVectorStore.search` method — you know it cold (it's in the SOLID band
of your confidence map). The strong walkthrough:

> "Sure. This is the search method on my pgvector adapter. First line —
> `assertDim(vector)` — it length-checks the query vector against 768
> before any SQL runs; a wrong-dimension vector fails fast instead of
> hitting a cryptic Postgres error. Then the query: I order by `embedding
> <=> $1::vector` — that `<=>` is pgvector's cosine *distance* operator,
> and I bind the query vector as a parameter and cast it to `vector`, so
> it's never string-concatenated into the SQL. I filter by `app_id` and
> limit to k. In the select I compute `1 - (embedding <=> $1)` as the
> score, because `<=>` returns distance and I want similarity — so I
> subtract from 1. Then the part that's easy to miss: the rows come back
> as flat columns, but the citation tool expects the in-memory store's
> meta shape, so I rebuild `meta.docId`, `meta.chunkIndex`, `meta.text`
> from `document_id`, `chunk_index`, and `content`. If I got the
> signature right but skipped that rebuild, search would 'work' but
> citations would silently break. That meta rebuild is the load-bearing
> part people forget when writing an adapter."

That's line-level ownership (`src/pg-vector-store.ts:67-85`): you
explained *what* each line does and *why* it's there, including the
non-obvious cosine-distance-to-similarity conversion and the meta-rebuild
that most people forget. Whether or not AI helped write it is now
irrelevant — you demonstrably own it.

```
  ┃ Whether AI wrote the line stops mattering the moment you
  ┃ can explain why the line is there. Ownership is
  ┃ understanding, not authorship.
```

---

### Question 3 — "What did the AI get wrong?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Was there anything AI suggested that you had to push back    │
│    on, or that was just wrong?"                                 │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you critically evaluate AI output, or accept it? A         │
│   candidate who says "no, it was all great" either didn't use   │
│   AI much or didn't review it. They want evidence of            │
│   judgment applied to the tool's output.                        │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer — grounded in a real decision from this codebase:

> "The clearest one: the foreign key on chunks. The natural,
> textbook-correct suggestion is to put a foreign key from
> `chunks.document_id` to `documents.id` — and AI assistance defaults to
> that, because it's the 'right' relational hygiene. But it's wrong for
> this system, for two reasons I had to reason through myself: the
> `VectorStore` contract upserts chunks with no documents row, so a hard
> FK breaks drop-in parity with the in-memory store; and conversation
> memory rides the same chunks table with no parent document at all, so
> the FK would reject every memory write. So I dropped it deliberately and
> documented why. That's a case where the 'best practice' the tool
> reaches for was exactly the wrong call for the architecture, and I had
> to override it with a reason. More broadly, the thing AI is reliably
> wrong about is *my specific tradeoffs* — it knows the general patterns,
> it doesn't know that memory shares my chunks table, so it'll suggest the
> textbook constraint that my design specifically can't have."

This is a strong answer because the example is real and specific
(`sql/001_agents_schema.sql:18-27`), and it names the *category* of thing
AI gets wrong — your specific tradeoffs that override the general
best-practice. That generalization shows you've got a working mental
model of where the tool's judgment ends and yours begins.

#### The follow-up tree

```
  You give the dropped-FK override example.
        │
        ├─► IF THEY ASK "how do you catch when AI is wrong like that?"
        │     → I don't accept a suggestion I can't reason through.
        │       The FK looked right; I asked "what does this assume?"
        │       and the answer (a documents row must exist) collided
        │       with what I knew about memory rows. The collision
        │       caught it.
        │
        ├─► IF THEY ASK "doesn't that slow you down a lot?"
        │     → For load-bearing decisions, yes, and it should. For
        │       boilerplate I move fast. The judgment is knowing which
        │       is which — a FK on a shared table is load-bearing, an
        │       import statement isn't.
        │
        └─► IF THEY ASK "what else did it get wrong?"
              → The faithfulness eval — AI will happily call
                precision@k "your evals" and not flag that generation
                is unmeasured. I had to know the retrieval/faithfulness
                distinction myself to see the gap.
```

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                          ║
║                                                              ║
║   The honest edge of this chapter: they point at a region    ║
║   in the DEFAULTED-TO band and ask you to justify the        ║
║   default as if it were a deliberate call. "Why these exact  ║
║   HNSW parameters? Why this chunk size?" You didn't deeply   ║
║   evaluate these — and the trap is pretending you did.       ║
║                                                              ║
║   Say:                                                       ║
║   "Honest answer — that's a default I took, not a decision   ║
║    I drove. I ran pgvector's default HNSW parameters and my  ║
║    retrieval eval numbers held up, so I never went tuning.   ║
║    If you asked me to justify the specific m and             ║
║    ef_construction values as optimal, I can't — I didn't     ║
║    sweep them. What I CAN tell you is the knob: higher       ║
║    ef_construction trades build time for recall, and the     ║
║    moment my eval scores dropped at scale, that's the first  ║
║    thing I'd tune. So I'm owning it as a defaulted-to        ║
║    choice that's worked, with a clear next move if it stops  ║
║    working."                                                 ║
║                                                              ║
║   What this signals: you distinguish a decision you DROVE    ║
║   from a default you TOOK, you don't retroactively dress a   ║
║   default as deliberate, and you name the instrument         ║
║   (eval scores) and the knob (ef_construction) for when      ║
║   it'd need real attention. Owning the default cleanly is    ║
║   the senior move — faking the analysis is the junior one.   ║
║                                                              ║
║   Do NOT say:                                                ║
║   "I chose those parameters because they balance recall and  ║
║    performance optimally for my workload" — a retroactive    ║
║    justification for a sweep you never ran. The follow-up    ║
║    ("what recall did you measure at each setting?") ends it. ║
╚═══════════════════════════════════════════════════════════════╝
```

This is the chapter's keystone box and it ties the whole book together:
the cleanest thing you can do with an AI-assisted, defaulted-to decision
is *say it's a default*, name where it'd need real evaluation, and not
pretend the analysis happened.

---

### What the tools have actually taught you — the close

End the AI question — and the book — on genuine reflection, not a
talking point. The strong close:

> "What the tools have actually changed for me: they raised the floor on
> how fast I can get something working, which means the bottleneck moved
> from typing to *judgment*. The hard part of this project was never
> producing code — AI made that fast. The hard part was the decisions:
> what to colocate, where to draw the library boundary, what to measure,
> what constraint to drop. AI doesn't make those for you — it'll suggest
> the textbook default, and your job is knowing when the textbook is
> wrong for your system. So if anything, building this with heavy AI
> assistance made me *more* deliberate about decisions, not less —
> because the code stopped being the scarce thing, and the judgment
> became the whole job. That's the shift I'd want a senior interviewer to
> see: I'm not afraid of the tools, and I know exactly which part of the
> work is still mine."

That close is grounded — it names a real change in how the work feels
(judgment over typing) and ties it back to the project's actual hard
parts (the decisions). It's the opposite of defensive, and it's the note
that leaves the interviewer thinking "this person owns their work."

```
  ┃ AI moved the bottleneck from typing to judgment. The code
  ┃ stopped being scarce; the decisions became the whole job.
  ┃ That's the shift to show, and it's the truth.
```

---

## One-page summary — Chapter 8

**Core claim:** The AI question tests ownership, not AI use. Be
matter-of-fact about the tool's role, structure your decisions into
three honest modes, and never claim a line you can't explain.

**The questions covered:**

- **"Did you use AI?"** — Yes, heavily, no flinch. Three modes:
  deliberate / evaluated-and-accepted / defaulted-to. "Never shipped a
  line I couldn't explain."
- **"Explain line by line"** — Pick `PgVectorStore.search`: assertDim,
  `<=>` cosine distance, `1 - distance` similarity, the meta rebuild most
  people forget. Demonstrable ownership.
- **"What did AI get wrong?"** — The dropped FK: AI defaults to the
  textbook constraint; your design (memory in chunks, contract parity)
  specifically can't have it. AI is wrong about your specific tradeoffs.

**Pull quotes:**

```
  ┃ "I used it heavily and never shipped a line I couldn't
  ┃ explain" — that's the one a senior interviewer trusts.

  ┃ Ownership is understanding, not authorship.

  ┃ AI moved the bottleneck from typing to judgment.
```

**The "I don't know":** A defaulted-to choice (HNSW params, chunk size)
— say it's a default you took, name the instrument (eval scores) and the
knob (ef_construction), don't retroactively dress it as a deliberate
sweep.

**What you'd change:** Nothing about owning the AI use — but the
defaulted-to band is where you'd do the most real evaluation next (start
with the HNSW params the day the eval scores move).

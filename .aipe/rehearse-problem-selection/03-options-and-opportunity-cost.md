# Chapter 3 — Options and Opportunity Cost

This is the crux chapter. Every other chapter supports this one. When an interviewer hears "self-hosted personal agent," the very next thought is *"Hermes already exists — why didn't you just use it?"* If you can't answer that, the whole project reads as reinventing a wheel out of ignorance. If you *can* answer it — cleanly, in a way that shows you evaluated the off-the-shelf option and rejected it for a specific reason — the project flips from "naive" to "deliberate." Build-vs-buy is the single most important problem-selection decision in the project, and you actually made it on the record.

```
  THE OPTIONS — three real choices, named with their cost

  ┌─ OPTION A: DO NOTHING ────────────────────────────────┐
  │  keep pitching the pivot on assertion.                │
  │  cost: the pivot stays unproven; the gap compounds.   │
  └────────────────────────────────────────────────────────┘
  ┌─ OPTION B: BUY (install Hermes) ──────────────────────┐
  │  get a working personal agent today.                  │
  │  cost: proves nothing about your engineering — a       │
  │  turnkey tool HIDES the parts that signal skill.      │
  └────────────────────────────────────────────────────────┘
  ┌─ OPTION C: BUILD (this project) ──────────────────────┐ ◄── chosen
  │  one agent, end to end, on AptKit + stock Gemma +      │
  │  pgvector, borrowing Hermes' trajectory discipline.   │
  │  cost: ~4 weeks of your time. buys: the portfolio      │
  │  case — the exact parts Hermes would have hidden.     │
  └────────────────────────────────────────────────────────┘
```

The verdict is Option C, and the *reason* is the whole game. Here's how you walk each option.

## Option A — do nothing

Always put `do nothing` on the table first; it's the option a sloppy answer forgets, and naming it shows you actually weighed cost against benefit.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Did you need to build anything at all? Couldn't you   │
  │    just keep doing frontend?"                           │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Did you weigh the cost of inaction, or did you just    │
  │   want to build something cool? 'Do nothing' is the      │
  │   baseline every real decision is measured against.     │
  └─────────────────────────────────────────────────────────┘

> "Doing nothing is a real option, and it has a real cost. I'd keep my frontend career, which is fine — but the pivot into AI engineering would stay an *assertion*. In an interview I'd be saying 'I can do AI engineering' with AdvntrCue as my only evidence, and AdvntrCue welded OpenAI into the embedding path — it doesn't show I can build the provider contract or the eval layer that separate 'played with an LLM' from 'does AI engineering.' The cost of doing nothing is that the pivot stays slow and unproven, and that cost compounds every month I delay. So do-nothing is the baseline — and it loses, because the gap it leaves is the exact gap a hiring manager probes."

## Option B — buy (install Hermes) — and why it loses

This is the decision. Take your time on it. The interviewer is looking for one thing: did you *evaluate* the off-the-shelf option, or did you not know it existed? You evaluated it, and your design doc records exactly why it lost.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Hermes is a working self-hosted personal agent. Why   │
  │    didn't you just install it?"                         │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   The whole project's legitimacy. If your answer is      │
  │   'I didn't know about it' or 'mine is better,' you      │
  │   lose. The winning answer is 'buying defeats the        │
  │   purpose, and here's the precise reason.'              │
  └─────────────────────────────────────────────────────────┘

> "I did evaluate using Hermes directly, and I chose to build instead — for one specific reason: a turnkey tool hides exactly the parts that signal engineering skill. If I install Hermes, I have a working agent and I've proven nothing. What a hiring manager wants to see is the engineering Hermes abstracts away: a provider contract with a real Gemma implementation, a RAG pipeline I actually built — chunking, embeddings, pgvector with an HNSW index, retrieval ranking — a centralized multi-tenant schema, and evals with *numbers*. That's the portfolio thesis in one line: building the route exposes the parts a turnkey tool hides. So I'm not competing with Hermes on features — Hermes wins on features, it's a whole platform. I'm borrowing its *discipline* — capturing every conversation as a trajectory so fine-tuning is answerable later — and building the rest myself, because the building *is* the deliverable."

Then the part that proves you actually understand Hermes, not just that it exists:

> "And I'm explicit about what I'm *not* copying. Hermes is a multi-agent Python platform running Nous Research's own fine-tuned models — Hermes is fine-tunes of Llama, Mistral, Qwen. I'm running stock Gemma 2 in TypeScript and stealing only the patterns, above all: capture every conversation as a trajectory *now* so fine-tuning is answerable *later*, not assumed. I'm not fine-tuned, I'm not a fleet, I'm not a platform. The contrast is deliberate — knowing precisely what Hermes is lets me take the one idea worth taking and leave the machinery I don't need."

```
  BUILD vs BUY — what each option exposes vs hides

                     │ BUY (Hermes)      │ BUILD (this)
  ───────────────────┼───────────────────┼──────────────────
  working agent      │ ✓ today           │ ✓ after ~4 weeks
  provider contract  │ HIDDEN            │ ✓ you wrote it
  RAG pipeline       │ HIDDEN            │ ✓ you built it
  centralized schema │ HIDDEN            │ ✓ you designed it
  eval numbers       │ HIDDEN            │ ✓ you measured them
  ───────────────────┼───────────────────┼──────────────────
  portfolio value    │ ~zero (it's       │ HIGH (the hidden
                     │ someone's tool)   │ parts ARE the case)

  buying optimizes for HAVING the agent.
  building optimizes for PROVING you can build one.
  your goal is the second, so you build.
```

  ┃ "I'm not competing with Hermes on features — it wins,
  ┃  it's a platform. I'm borrowing its discipline and
  ┃  building the rest, because the building is the
  ┃  deliverable."

## Option C — build, but don't over-build (the balance)

The danger in "build" answers is over-correcting into "I built everything from scratch," which is its own red flag — it means you wasted time reinventing solved problems. Your plan has the balance written into it: *"build the glue and the judgment layer. Don't reinvent the agent loop or vector search — that costs scope and hides the interesting parts. Use AptKit, use Gemma off-the-shelf, use pgvector."*

> "Building doesn't mean building everything. I use AptKit for the agent loop and the runtime — reinventing the ReAct loop would cost scope and hide the interesting parts, not show them. I use stock Gemma off-the-shelf, not a fine-tuned model. I use pgvector, not a hand-rolled vector index. What I build is the *glue and the judgment layer*: the Gemma provider that emulates tool-calling because Gemma emits none, the RAG pipeline, the centralized schema, the eval scorers, and the measurement-driven decision about whether to ship, iterate, or fine-tune. That's the line — build the parts that show engineering judgment, buy the parts that are solved. Building the agent loop would prove I can follow a paper; building the eval-driven decision proves I can do the job."

This is also where the smaller build-vs-buy calls live, and each is a `do nothing`/`buy`/`build` decision in miniature:

| Decision | Bought / used off-the-shelf | Built |
|----------|------------------------------|-------|
| Agent loop | AptKit's `run-agent-loop` (bounded ReAct) | — |
| Vector search | pgvector + HNSW (not hand-rolled) | the `PgVectorStore` adapter over it |
| Embeddings | `nomic-embed-text` (purpose-built, not Gemma) | the embedding provider wiring |
| Generation model | stock `gemma2:9b` (not fine-tuned) | the provider + tool-call emulation |
| Eval metrics | — (didn't exist in AptKit) | `scorePrecisionAtK` / `scoreRecallAtK` |

The opportunity cost is named on both sides. Reinvent the loop → lose weeks, prove nothing new. Build nothing → it's just Hermes again. The chosen line — build the glue, buy the substrate — is the one that maximizes portfolio signal per week spent.

## When you're cornered

  ╔═════════════════════════════════════════════════════════╗
  ║ IF THEY SAY                                              ║
  ║   "Building it yourself just to learn is résumé-driven    ║
  ║    development. In a real job you'd buy."                ║
  ║                                                         ║
  ║ DON'T                                                    ║
  ║   Argue that buying is always wrong. It isn't, and       ║
  ║   they'll know it. Don't pretend this was a production   ║
  ║   build-vs-buy when it was a portfolio one.             ║
  ║                                                         ║
  ║ DO                                                       ║
  ║   "You're right that in production, for a shipping       ║
  ║    product, I'd lean buy — and I do exactly that inside  ║
  ║    this project: I bought the agent loop, the vector     ║
  ║    index, the model. But the *goal* here is different.   ║
  ║    The deliverable isn't a running tool — it's           ║
  ║    demonstrated capability. For that goal, building the  ║
  ║    parts that signal skill is the correct call, and      ║
  ║    knowing *which* parts to build versus buy is itself   ║
  ║    the production judgment you're testing for. I didn't  ║
  ║    rebuild pgvector. I built the eval layer. That split  ║
  ║    is the answer to your objection."                    ║
  ╚═════════════════════════════════════════════════════════╝

The judo here: the interviewer's "you'd buy in production" objection is *answered by the project itself*, because the project buys the substrate and builds only the judgment layer. You don't fight the objection — you show the project already embodies the right instinct.

## The one-page version

**Core claim:** Three options — do nothing (pivot stays unproven, cost compounds), buy/install Hermes (working agent, proves nothing because a turnkey tool hides the skill-signaling parts), build (the chosen option: one agent on AptKit + stock Gemma + pgvector, borrowing Hermes' trajectory discipline). Build wins because the *building is the deliverable* — but the build is disciplined: buy the substrate (loop, vector index, model), build the glue and judgment layer (provider + tool-call emulation, RAG pipeline, schema, evals).

**The questions, one-line answers:**
- "Why not just install Hermes?" → A turnkey tool hides exactly the parts that signal skill — the provider contract, the RAG pipeline, the schema, the eval numbers. The hidden parts *are* the portfolio.
- "Do you understand Hermes?" → Yes — it's a multi-agent Python platform on Nous's fine-tuned models. I run stock Gemma in TS and steal only the trajectory-capture discipline.
- "Didn't you reinvent the wheel?" → No — I bought the loop, the vector index, the model. I built only the glue and the judgment layer.
- "Isn't this résumé-driven?" → In production I'd buy, and I do — inside the project. The goal here is demonstrated capability, and the build/buy split *is* the judgment being tested.

**The pull quote you keep:** *"A turnkey tool hides exactly the parts that signal engineering skill. Building this route exposes them — and the building is the deliverable."*

→ Next: Chapter 4, success metrics. The build is justified — now, how do you know it actually worked? The eval numbers are what make "build" defensible instead of indulgent.

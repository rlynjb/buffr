# Chapter 6 — The Hard Parts

This is the reflection chapter — the hardest bug, the part you're proudest of, the part you're least confident defending. These questions feel softer than the technical ones, but they're the ones that separate candidates the most, because they reveal how you think about your own work. The trap is treating "what are you least confident about?" as a question to dodge. It isn't. Handled right, it's the strongest signal you can send: a senior engineer who knows exactly where the bodies are buried in their own code reads as someone who'd know where they are in the company's code too.

For `buffr-laptop`, the hard parts are unusually rich because the system has real subtlety packed into a small codebase. The proudest part is the storage adapter that makes Postgres invisible to the agent. The hardest conceptual bug is the silent failures around the embedding dimension and the tool-call emulation. And the part you're least confident defending is the evaluation gap — you measure retrieval but not faithfulness, which means your eval could give a perfect score to a hallucinated answer. This chapter teaches you to own all three.

```
  THE CONFIDENCE MAP — how firmly you defend each region

  HIGH CONFIDENCE ████████  defend without hedging
  ┌───────────────────────────────────────────────────────────┐
  │ ████ PgVectorStore — VectorStore contract over pgvector    │
  │ ████ embedding-dimension defense (fail loud, never truncate)│
  │ ████ deterministic chunk ids → idempotent re-index         │
  │ ████ the bounded loop + forced synthesis (you understand   │
  │      it cold, even though it's the library's)              │
  └───────────────────────────────────────────────────────────┘
  MEDIUM CONFIDENCE ████░░░░  defend, name the seam
  ┌───────────────────────────────────────────────────────────┐
  │ ███░ tool-call emulation (library's; you know how it works  │
  │      and where it silently fails)                          │
  │ ███░ trajectory capture (you built it; it's write-only)    │
  └───────────────────────────────────────────────────────────┘
  LOWER CONFIDENCE ██░░░░░░  own the gap, name the fix
  ┌───────────────────────────────────────────────────────────┐
  │ ██░░ FAITHFULNESS — eval scores retrieval, not answer      │
  │      quality. Perfect chunks + hallucination = score 1.0   │
  │ ██░░ HNSW internals + ef_search tuning (defaults, untuned) │
  └───────────────────────────────────────────────────────────┘
```

The map is your honest self-assessment, and it's also your playbook: lead with the high-confidence regions, name the seam in the medium ones, and own the low ones with a fix attached. Never the reverse.

## The proudest part

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What part of this are you proudest of?"              │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you identify what's actually hard about your own   │
  │   system, versus what just took the most time? Do you    │
  │   pick something with engineering substance, or a        │
  │   surface feature?                                      │
  └─────────────────────────────────────────────────────────┘

> "The storage adapter — `PgVectorStore`. It implements aptkit's VectorStore contract, which is two methods and a dimension constant, so the entire agent loop has no idea it's talking to Postgres instead of an in-memory store. Same contract, swapped body. What I'm proud of is that the same round-trip test passes against both stores, which proves the boundary holds. The detail that makes it real is the read path: pgvector stores the chunk fields in columns, but the citation tool reads them out of a `meta` object, so on the way out I rebuild `meta` from the columns — `docId`, `chunkIndex`, `text`. If I returned raw columns, retrieval would rank correctly and citations would come back empty — a silent failure. That one mapping line is the difference between an adapter that works and one that looks like it works."

Decision mode: **deliberate** — this is the part you most clearly own. Lead with it. The proudest-part answer should always be something with a non-obvious hard part, and "the mapping line that prevents a silent citation failure" is exactly that kind of detail.

  ┃ "The hard part of an adapter isn't the methods.
  ┃  It's the one mapping line that, if you forget it,
  ┃  makes everything look like it works while silently
  ┃  failing."

## The hardest bug — the silent-failure class

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What was the hardest bug you dealt with?"            │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you describe a real debugging story — symptom,     │
  │   investigation, root cause, fix? Or do you only have    │
  │   "it didn't work and then it did"? The best stories     │
  │   are about SILENT failures, because those are the       │
  │   ones that test real understanding.                    │
  └─────────────────────────────────────────────────────────┘

> "The hardest class of bug in this system is the silent ones — failures that don't throw, they just degrade. The clearest example: when the model asked the search tool for only one chunk. The tool was giving the model exactly what it asked for, so retrieval looked fine, but answers were thin because one chunk often isn't enough context. There was no error to chase — the symptom was just mediocre answers. The fix was to floor the result count, so a model asking for one chunk still gets four. That's the category I learned to watch for here: the system is full of places where a wrong input produces a worse result instead of an error. A wrong embedding dimension would index fine and retrieve garbage — which is why I made that one throw. A wrong tool-argument key searches the empty string. The debugging skill this taught me is that in a RAG system, 'it returned something' is not 'it returned the right thing,' and you have to build the check that turns a silent degradation into a loud one."

The reason this is a strong answer: it's not a single bug, it's a *pattern* of bug, and you name how you changed your debugging approach because of it. That's the difference between "I fixed a thing" and "I learned something about this class of system." Interviewers remember the second.

```
  "Hardest bug?"
        │
        ▼  the silent-degradation class
        │
        ├─► IF THEY ASK "HOW DID YOU FIND IT?"
        │     The eval harness. It scores retrieval in
        │     isolation, so I could see the retrieval half
        │     was fine and the problem was upstream context,
        │     not the database.
        │
        ├─► IF THEY ASK "HOW DO YOU PREVENT THE CLASS?"
        │     Make degradations throw where I can — the
        │     dimension assertion is the model for that. Where
        │     I can't (the empty-string search), name it as a
        │     known gap and fix it at my boundary.
        │
        └─► IF THEY ASK "WHAT'S STILL SILENT?"
              The wrong-tool-arg-key search and the
              faithfulness gap. I know where they are; I
              haven't closed them yet.
```

## The part you're least confident defending — faithfulness

This is the one to handle with care, because it's both your weakest spot and, handled right, a strong-signal answer.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What part of this are you least confident about?"    │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know your own system's real weakness, or will   │
  │   you offer a fake-humble non-weakness ("I wish I'd      │
  │   added more tests")? Can you name a genuine gap and     │
  │   show you understand WHY it matters and HOW you'd       │
  │   close it?                                             │
  └─────────────────────────────────────────────────────────┘

> "Faithfulness measurement. My eval scores retrieval — precision and recall against a labeled query set — but it stops there. It never calls the model, so it never checks whether the generated answer is actually grounded in the retrieved chunks. That means a run can score a perfect precision and still hand the user a hallucinated answer over perfectly-retrieved chunks, and my eval would report 1.0 and never know. I'm least confident here because it's the gap between 'my retrieval works' and 'my system gives good answers,' and right now I can only prove the first. The library actually ships a rubric judge I could wire up to score groundedness — the reason I haven't is the trap in doing it naively: if I judge Gemma's answers with Gemma, I get self-preference bias. To do it right I'd judge with a different, stronger model family, which breaks fully-local for the eval step — and I'd accept that, because measuring faithfulness matters more than keeping the eval local."

Why this is strong, not weak: you name a genuine gap, you explain exactly why it matters (perfect retrieval score over a hallucination), you know the tool that closes it (the rubric judge), *and* you know the subtle trap in using it (self-preference bias). That's four layers of understanding on top of a "weakness." An interviewer hears that and thinks "this person understands evaluation better than most people who claim it's a strength."

  ┃ "A hallucinated answer over perfect chunks scores
  ┃  1.0 on my eval. Knowing exactly where my measurement
  ┃  goes blind is worth more than pretending it doesn't."

## The medium-confidence parts — name the seam

When the interviewer probes the tool-call emulation or the trajectory capture, you're on medium ground — you understand them deeply, but one is the library's and the other is write-only. The move is to claim what you understand and name the seam honestly.

On emulation: *"That's the library's mechanism, but I understand it because the whole project depends on it. Gemma has no native tool API, so the provider renders the tool schema into the prompt and parses JSON back out. I know exactly where it breaks — the wrong-argument-key silent search — and I know the fix has to live on my side because I don't edit the library."*

On trajectory capture: *"That one's mine. I persist every turn of the agent's run to Postgres. The honest framing is that it's capture, not recall — I write the trajectories but never read them back into a later run. Each ask starts fresh. The reason to capture them now is that you can't capture them retroactively, and if I ever wanted to fine-tune on real interactions, I'd need them from day one. It's a deliberately-kept option, not unused dead weight."*

Both answers do the same thing: claim the understanding, name the exact boundary of what you built versus consumed, and frame the gap as a decision rather than an omission.

## Strong vs. weak — the "least confident" answer

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK ANSWER                  │ STRONG ANSWER                │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "Honestly I'm pretty         │ "Faithfulness. I measure     │
  │ confident in all of it. If   │ retrieval but not whether the │
  │ anything maybe I'd have      │ answer is grounded in the    │
  │ written more tests, but the  │ chunks — so a hallucination  │
  │ code is solid."              │ over perfect chunks scores   │
  │                              │ 1.0 and my eval never knows. │
  │                              │ The fix is a rubric judge,    │
  │                              │ but judged with a different   │
  │                              │ model to avoid self-          │
  │                              │ preference bias."             │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ "Confident in all of it" is  │ Names a real, specific gap,   │
  │ either a lie or a lack of    │ explains the concrete         │
  │ self-awareness — both read   │ consequence, knows the fix    │
  │ badly. "More tests" is the   │ AND the trap in the fix.      │
  │ fake-humble non-answer every │ Reads as someone who          │
  │ interviewer has heard a      │ understands their system's    │
  │ thousand times.              │ blind spots precisely.        │
  └──────────────────────────────┴──────────────────────────────┘

"I'm confident in all of it" is the answer that loses you the most points in the whole interview, because it signals you either can't see your own weaknesses or won't admit them. Neither is what a senior hire looks like. The strong answer is almost paradoxical: naming your weakness precisely is how you demonstrate strength.

## When you don't know

Even in your area of pride, the interviewer can dig past your depth — into the HNSW graph internals you rely on but didn't implement.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They follow your proudest-part answer with: "You're    ║
  ║   proud of the storage layer — so how does the HNSW      ║
  ║   index decide which neighbors to compare during a       ║
  ║   search? Walk me through the algorithm."               ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I'm proud of the adapter and the contract boundary —  ║
  ║    that's the part I built. The HNSW algorithm itself is ║
  ║    pgvector's, and I haven't implemented or deeply       ║
  ║    studied the graph traversal. What I know operationally:║
  ║    it's a navigable small-world graph, approximate, with ║
  ║    ef_search as the recall knob. I chose it for the      ║
  ║    incremental-insert property, not because I can derive  ║
  ║    the traversal. If you want to go into the layer        ║
  ║    descent, I'd be learning it from you."                ║
  ║                                                          ║
  ║   What this signals: you separate what you BUILT (and    ║
  ║   own fully) from what you USE (and understand            ║
  ║   operationally but not internally). That distinction is ║
  ║   exactly the precision a senior interviewer is testing  ║
  ║   for. Pride in the adapter doesn't obligate you to       ║
  ║   know the index internals.                             ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "It builds a hierarchy of graphs and searches the top  ║
  ║    layer first and… works its way down, finding the      ║
  ║    closest ones at each level, roughly."                 ║
  ║   If you can't actually walk it, a vague gesture invites  ║
  ║   "what determines the number of layers?" and you're     ║
  ║   exposed. Stop at what you genuinely know.              ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

The hard-parts change you'd make is closing the faithfulness gap — and it's the same one you named as your weakest spot, which is the point: your weakest spot and your top counterfactual should be the same thing, because that's what makes the self-assessment honest. You'd wire the rubric judge to score groundedness on the eval set, judged by a different model family than the one being graded. That single addition turns your eval from "does retrieval work" into "does the system give good answers," which is the question that actually matters. It's the highest-leverage thing you could add to the whole project, and you can describe it precisely — which is why naming it costs you nothing and signals everything.

## One-page summary

**Core claim:** Lead with the high-confidence parts, name the seam in the medium ones, and own the weak ones with a fix attached. Naming your real weakness precisely is the strongest signal in the interview.

**The questions, one line each:**
- *"Proudest of?"* → The PgVectorStore adapter — Postgres is invisible to the agent, and the meta-rebuild line prevents a silent citation failure.
- *"Hardest bug?"* → The silent-degradation class (the model asking for one chunk) — taught me "it returned something" ≠ "it returned the right thing."
- *"Least confident?"* → Faithfulness — I score retrieval, not answer groundedness; a hallucination over perfect chunks scores 1.0.
- *"How's the emulation work?"* → Library's; schema rendered into prompt, JSON parsed back; I know its silent-failure (wrong arg key).

**Pull quotes:**
- "The hard part of an adapter is the one mapping line that, if you forget it, makes everything look like it works while silently failing."
- "A hallucinated answer over perfect chunks scores 1.0 on my eval. Knowing where my measurement goes blind is worth more than pretending it doesn't."

**What you'd change:** Wire the rubric judge to score faithfulness, judged by a different model family — the same gap as my weakest spot, which is how I know the self-assessment is honest.

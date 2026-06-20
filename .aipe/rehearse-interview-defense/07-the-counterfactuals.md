# Chapter 7 — The Counterfactuals

"What would you do differently?" is the question that most rewards the senior habit of volunteering what you'd reconsider before being asked. A junior engineer defends every decision as if it were perfect. A senior engineer says "here are the three things I'd revisit, here's why, and here's the one I'd leave exactly as it is." The volunteering is the signal — it shows you evaluate your own work the way a reviewer would, continuously, without being prompted.

The trap in this chapter is the opposite of bluffing: it's *fabricating regrets*. If you invent a counterfactual for a decision that was obviously right — "I'd switch from pgvector to Pinecone" when pgvector was the correct call — you signal that you don't actually understand why your decisions were good. The skill is naming the genuinely-reconsiderable decisions and *defending* the ones that were right against the temptation to second-guess them. This chapter walks the four most reconsiderable decisions in `buffr-laptop` and the ones you'd defend unchanged.

```
  THE COUNTERFACTUALS MATRIX

  decision                  │ would you change it? │ what you'd do
  ──────────────────────────┼──────────────────────┼─────────────────
  faithfulness eval         │ YES — top priority   │ wire rubric judge,
  (retrieval only)          │                      │ different model
  ──────────────────────────┼──────────────────────┼─────────────────
  index atomicity           │ YES — one txn fix    │ pin one connection
  (two transactions)        │                      │ through both writes
  ──────────────────────────┼──────────────────────┼─────────────────
  tool-arg validation       │ YES — wrapper        │ schema-validate args
  (no schema check)         │                      │ before tool runs
  ──────────────────────────┼──────────────────────┼─────────────────
  ef_search tuning          │ YES — measure first  │ exact baseline,
  (left at default)         │                      │ then sweep
  ──────────────────────────┼──────────────────────┼─────────────────
  pgvector over Pinecone    │ NO — right call      │ defend it, don't
  (colocation)              │                      │ fake a regret
  ──────────────────────────┼──────────────────────┼─────────────────
  consuming aptkit          │ NO — right scope     │ would do it again
  (not building the loop)   │                      │
  ──────────────────────────┼──────────────────────┼─────────────────
  no RLS this phase         │ NO — correct for now │ gated on app #2
  (deferred)                │                      │ writing
```

The matrix is the chapter. Four genuine "yes" rows you volunteer, three "no" rows you defend against second-guessing. Knowing which is which — and not faking a regret in the bottom three — is the whole skill.

## The counterfactual you lead with: faithfulness

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "If you were starting this over today, what would      │
  │    you do differently?"                                 │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you name a real improvement without prompting?     │
  │   Is it something with engineering substance, or a       │
  │   surface tweak? Does it match what you said your        │
  │   weakness was, or do your stories contradict?          │
  └─────────────────────────────────────────────────────────┘

> "I'd build faithfulness evaluation in from the start. Right now I measure retrieval — precision and recall — but not whether the answer is grounded in the chunks, so I can't actually prove the system gives good answers, only that it retrieves the right ones. If I were starting over, the rubric judge would be wired from day one, scoring groundedness with a different model family than the one being graded. Building it in early matters because eval is the thing that tells you whether your changes help — without a faithfulness number, I'm optimizing retrieval blind to whether it improves the actual output. It's the highest-leverage thing I'd add."

This is the same gap you named as your weakest spot in Chapter 6, and that's intentional — your weakest-spot answer and your top-counterfactual answer should be the same decision. If they're different, one of them is dishonest. Consistency across your stories is itself a signal that you're describing real understanding rather than rehearsed lines.

  ┃ "Your top counterfactual and your weakest spot
  ┃  should be the same decision. If they're not, one
  ┃  of them isn't honest."

## The structural counterfactual: index atomicity

> "I'd make the index write atomic. Today the document row and its chunks are written in two separate transactions, so a crash between them leaves a document with no chunks. It's tolerable because the data is re-derivable and re-indexing is idempotent, but it's the dual-write problem, and the fix is genuinely small — thread one pinned connection through both writes so they commit together. The reason I'd change it is that it also closes the orphan-chunk case in the same move: one transaction, two problems gone. Small change, high leverage. It's the cleanest counterfactual in the codebase."

Decision mode honesty: this was a **deliberate** tradeoff you accepted, and the counterfactual is "I'd accept it differently now that it's nearly free to fix." That's a mature framing — not "I was wrong" but "the cost-benefit shifted once I saw how small the fix is."

## The reliability counterfactual: tool-argument validation

> "I'd add argument validation around the tool-call emulation. Because Gemma's tool-calling is emulated through prompt-and-parse, a model that puts the search query under the wrong key parses fine but searches the empty string — a silent failure. The library doesn't validate arguments against the tool schema, and I can't edit the library, so I'd add a thin wrapper on my side that schema-validates the arguments before the tool runs and rejects or repairs a malformed call. It's the difference between a wrong tool call failing loudly and degrading silently, and silent degradation is the failure class I trust least in this system."

This ties back to Chapter 5's silent-failure theme and Chapter 6's hardest-bug story — the same understanding surfacing in three chapters, which is exactly the coherence you want. One real understanding, multiple questions, consistent answer.

## The measurement counterfactual: ef_search

> "I'd tune the index, but more importantly I'd build the ability to *know* whether it needs tuning. The HNSW `ef_search` knob is at the default — I never set it — and it's the highest-leverage recall-vs-latency dial in the retrieval path. The thing I'd change isn't just the value; it's that I have no exact-scan baseline to tune against, so a recall regression would be invisible. Starting over, I'd build the exact baseline first — force Postgres to skip the index for ground-truth neighbors — then sweep `ef_search` against my eval set. Measure first, then tune. Tuning a knob you can't measure is just guessing."

Decision mode: this is the **defaulted-to** decision in the counterfactual chapter — you didn't decide on the default `ef_search`, you just never changed it. Owning that it was a default rather than a choice is the most senior-positive move available, because defaulting-to is the riskiest mode to admit and the most credible when admitted.

## The counterfactuals you DON'T make — defending the right calls

Here's where the chapter teaches the harder discipline. When the interviewer fishes for a regret on a decision that was right, you defend it. Don't manufacture humility about good calls.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Wouldn't you switch to a real vector database like     │
  │    Pinecone if you did it again?"                       │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Will you cave and invent a regret to seem humble, or   │
  │   do you actually understand why pgvector was right? A    │
  │   fake counterfactual here reveals you didn't            │
  │   understand the original decision.                     │
  └─────────────────────────────────────────────────────────┘

> "No — I'd make the same call. Pinecone would split my source of truth across two systems, add a network hop, and add a second billing surface, to solve a scaling problem I don't have. The colocation in one Postgres is worth more than peak ANN throughput at billions of rows I'll never reach. I'd switch the day vectors needed to scale on a different axis than my relational data — but inventing that regret now would mean I didn't understand why I chose pgvector in the first place. So I'll defend it."

The same applies to the other two "no" rows: consuming aptkit instead of building the loop was the right scope decision — building the loop would have cost time and hidden the interesting parts — and deferring RLS was correct for a single tenant, gated on a real trigger (a second app writing). When the interviewer pushes on these, defend them. Caving signals weakness; defending a genuinely-right decision signals you know *why* it was right.

  ┃ "Fabricating a regret for a decision that was right
  ┃  is worse than having no counterfactual. It proves
  ┃  you didn't understand the decision."

## Strong vs. weak — the counterfactual answer

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK ANSWER                  │ STRONG ANSWER                │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "I'd probably use a          │ "I'd build faithfulness eval │
  │ different vector database,    │ from day one. I measure       │
  │ and maybe a different        │ retrieval but not whether the │
  │ framework, and I'd rewrite   │ answer is grounded, so I       │
  │ the whole thing in a         │ can't prove answer quality —  │
  │ cleaner way."                │ only retrieval quality. The   │
  │                              │ rubric judge closes it, with  │
  │                              │ a different model to avoid    │
  │                              │ self-preference bias."        │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ Vague ("a cleaner way"),     │ Specific, substantive,        │
  │ and reaches for regrets on   │ matches the stated weakness,  │
  │ decisions that were right    │ knows the fix and the trap in │
  │ (the vector DB). "Rewrite    │ the fix. Volunteers a real    │
  │ the whole thing" signals you │ improvement without inventing │
  │ can't identify what          │ a regret for a good decision. │
  │ specifically was wrong.      │                              │
  └──────────────────────────────┴──────────────────────────────┘

The weak answer does both failure modes at once: it's vague, and it fabricates regrets about decisions that were correct. The strong answer names one specific, substantive change that matches everything else you've said. Precision plus consistency.

## When you don't know

In counterfactuals, the interviewer can push into "how would you redesign this for a scale or use case you've never built" — which lands you back at the distributed-systems edge.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They ask: "If you were redesigning this to serve a      ║
  ║   thousand teams, each with their own corpus, how would   ║
  ║   you re-architect the tenancy?"                         ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I can take the first step concretely and then I hit    ║
  ║    the edge of what I've built. The first step is real:   ║
  ║    every table already has app_id and every query         ║
  ║    filters on it, so the multi-tenant shape is there —    ║
  ║    what's missing is RLS and deriving app_id from a       ║
  ║    verified token instead of an env default. That         ║
  ║    migration is additive; the column did its job by       ║
  ║    existing. Beyond that — partitioning per tenant,        ║
  ║    isolating noisy tenants, scaling the index per         ║
  ║    corpus — I'm reasoning from principles, not from        ║
  ║    having operated it. I'd be honest with the team that    ║
  ║    that's where I'd need to learn or lean on someone       ║
  ║    who's done it."                                        ║
  ║                                                          ║
  ║   What this signals: you take the part you genuinely      ║
  ║   know as far as it goes (the additive RLS migration),    ║
  ║   then name the exact point where you'd be learning. The  ║
  ║   concrete first step earns you the right to say "I don't ║
  ║   know the rest" without it reading as a dodge.          ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "I'd just shard everything by tenant and add a          ║
  ║    caching layer and it'd scale fine."                   ║
  ║   "It'd scale fine" is the phrase that ends interviews.   ║
  ║   You don't know that, and claiming it invites the         ║
  ║   follow-up that proves you don't.                       ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

The meta-lesson of this chapter is the change you'd make to *how you decide*, not to the code: you'd build the measurement before the feature. The through-line in every genuine counterfactual here — faithfulness eval, ef_search tuning, even the atomicity fix's verification — is that you shipped the capability before you shipped the way to know whether it works. The senior counterfactual isn't "I'd write better code"; it's "I'd build the feedback loop first, so every later decision is measured instead of guessed." That's the habit you'd carry into the next project, and saying it that way shows you learned the right lesson from this one.

## One-page summary

**Core claim:** Volunteer the genuine counterfactuals; defend the decisions that were right. Fabricating a regret for a good decision is worse than having none.

**The counterfactuals, one line each:**
- *Faithfulness eval* → YES, top priority. Wire the rubric judge with a different model. (matches my weakest spot)
- *Index atomicity* → YES. One pinned transaction through both writes; closes orphan chunks too.
- *Tool-arg validation* → YES. Schema-validate args in my wrapper before the tool runs.
- *ef_search tuning* → YES, but measure first. Exact baseline, then sweep. (a default I never decided)
- *pgvector / aptkit / no-RLS* → NO. Right calls; I defend them rather than fake a regret.

**Pull quotes:**
- "Your top counterfactual and your weakest spot should be the same decision."
- "Fabricating a regret for a decision that was right proves you didn't understand the decision."

**What you'd change:** The habit, not the code — build the measurement before the feature, so every later decision is measured instead of guessed.

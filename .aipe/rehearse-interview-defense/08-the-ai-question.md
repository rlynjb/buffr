# Chapter 8 — The AI Question

This is the 2026 chapter. At some point the interviewer asks some version of "did you use AI to build this?" — and they already know the answer is yes, because everyone does. The question isn't a trap about whether you used AI. It's a test of whether you understand what you shipped well enough to own it. The candidates who fail this question are the ones who get defensive or evasive. The candidates who pass are matter-of-fact: here's what the AI did, here's what I did, here's what the tools have actually taught me. Grounded, not defensive.

You built `buffr-laptop` with significant AI assistance, and a lot of the cleverness lives in a library you consume rather than wrote. None of that is a problem — it's the baseline. What would be a problem is pretending otherwise, or being unable to explain a section you "wrote" when asked to go line by line. This chapter teaches the calibrated-honest answer, built on a framework that runs through the whole book: the three modes of how a decision got made.

```
  THE THREE MODES OF DECISION OWNERSHIP

  ┌─ DELIBERATE ──────────────────────────────────────────────┐
  │  My call, my reasoning. AI executed; I decided.           │
  │  e.g. local-first, pgvector colocation, consuming aptkit  │
  │  → Own it fully. "I chose X because Y."                   │
  └───────────────────────────────────────────────────────────┘
  ┌─ EVALUATED & ACCEPTED ────────────────────────────────────┐
  │  AI suggested; I checked it against alternatives and      │
  │  accepted. e.g. HNSW over IVFFlat, the dropped-FK pattern │
  │  → "AI suggested X. I evaluated it against Z for these    │
  │     reasons and accepted it."                            │
  └───────────────────────────────────────────────────────────┘
  ┌─ DEFAULTED TO ────────────────────────────────────────────┐
  │  AI's default; I didn't deeply evaluate it.               │
  │  e.g. ef_search untuned, no pool timeout, serial indexing │
  │  → RISKIEST to own, MOST senior-positive when owned well. │
  │     "That was the tool's default. I didn't evaluate it    │
  │      deeply — here's what I'd check before trusting it."  │
  └───────────────────────────────────────────────────────────┘

       defensiveness ◄──────────────────────► grounded honesty
       (worst answer)                          (best answer)
```

The three modes are the whole chapter. Every decision in your project sits in one of them, and the senior move is being able to *name which mode* each one is in — especially the third, because owning a defaulted-to decision honestly is the rarest and strongest signal you can send.

## The direct question

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Did you use AI to build this?"                        │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Not whether you used AI — they assume you did. Whether │
  │   you're defensive about it, and whether you can be      │
  │   precise about the division of labor. Evasiveness here  │
  │   is the only wrong answer.                              │
  └─────────────────────────────────────────────────────────┘

> "Yes, heavily — it's how I work now. The honest division: AI helped me assemble a lot of the code, and a big share of the cleverness lives in aptkit, the library I consume and never edit — the agent loop, the tool-call emulation, the eval scorers, the conversation-memory engine. What I brought is the judgment and the integration. I decided local-first, I decided to colocate vectors and relational data in one Postgres, I implemented the pgvector store against the library's contract, I built the Ink chat REPL — React in the terminal, which is squarely my background — and I made the wiring calls, like injecting my store into the memory engine. I can tell you for any decision in the project whether it was my call, something AI suggested that I evaluated and accepted, or something I took as a default and didn't dig into. That last category is the one I'm most careful to be honest about, because that's where the real risk lives."

That answer does everything: it's immediate and unembarrassed, it draws the exact seam between what you wrote and what you consumed, and it introduces the three modes — which signals you think about AI assistance with more nuance than the interviewer expected. You've turned a yes/no question into a demonstration of judgment.

  ┃ "The question isn't whether you used AI. It's whether
  ┃  you can name, for every decision, which mode it was
  ┃  made in."

## The harder question: explain this line by line

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Pick a file. Walk me through it line by line. What    │
  │    does this do, and why is it there?"                  │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Can you explain code that's in your repo, or did you   │
  │   accept it without understanding it? This is the real   │
  │   AI test — not whether you used it, but whether you     │
  │   understand the output.                                │
  └─────────────────────────────────────────────────────────┘

The defense here is preparation, not improvisation. Pick `src/pg-vector-store.ts` — it's the file you understand best, it's genuinely yours, and it has real subtlety. You can walk it cold:

> "This implements the library's VectorStore contract over pgvector. The constructor takes the pool and defaults the dimension to 768. `assertDim` throws if a vector's length is wrong — and it throws rather than truncating on purpose, because a silently-truncated vector would index fine and retrieve wrong forever. `upsert` runs all the inserts in one transaction on a pinned connection with rollback on failure, and uses `on conflict (id) do update` so re-indexing the same chunk overwrites rather than duplicates. `search` is the interesting one: `<=>` is pgvector's cosine *distance* operator, so I report `1 minus distance` as the similarity score — the same operator used twice, once to rank and once flipped to report. And the return mapping rebuilds the `meta` object from the columns, because the citation tool reads `meta.text` and `meta.docId` — without that rebuild, retrieval ranks fine but citations come back empty."

That's a line-by-line walk of a file you own, with the *why* attached to each part. The lesson: before any interview, pick the two or three files you can defend at this depth and know them cold. Don't try to defend the whole repo at line granularity — defend the parts that are genuinely yours, deeply, and be honest that the library internals are not in that set.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They open a library file — the agent loop's forced-     ║
  ║   synthesis logic inside aptkit — and ask you to walk it  ║
  ║   line by line.                                          ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "That's library code — aptkit's, not mine. I can tell   ║
  ║    you exactly what it does and why it matters, because   ║
  ║    my system depends on it: on the final turn it sets     ║
  ║    the tools to undefined and appends a synthesis         ║
  ║    instruction, so the model physically can't call a      ║
  ║    tool and must answer. But I didn't write this function ║
  ║    and I won't walk it line by line as if I did. I        ║
  ║    understand its contract and its behavior; the          ║
  ║    implementation is the library's."                     ║
  ║                                                          ║
  ║   What this signals: you don't claim authorship of code   ║
  ║   you consumed, you DO understand its behavior and why    ║
  ║   it matters, and you draw the line cleanly. That's the   ║
  ║   single most important honesty move in the AI era —      ║
  ║   understanding without overclaiming.                    ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "Sure, so this line, um, sets up the… let me see…       ║
  ║    it's handling the tool stuff here…"                   ║
  ║   Faking authorship of library code is the fastest way    ║
  ║   to lose all the credibility you built. The interviewer  ║
  ║   can tell instantly.                                    ║
  ╚═══════════════════════════════════════════════════════════╝

## The reflective question: what did the AI get wrong?

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What did the AI get wrong, or what did you have to     │
  │    push back on?"                                       │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you use AI critically or accept whatever it          │
  │   produces? Can you point to a place where your           │
  │   judgment overrode the tool's output? That's the        │
  │   difference between using AI and being used by it.      │
  └─────────────────────────────────────────────────────────┘

> "The clearest place is the defaulted-to decisions, where I have to be honest that I *didn't* push back enough. The `ef_search` index parameter is at the library and pgvector default — I didn't evaluate whether it was right for my corpus, and there's a recall risk hiding there I can't currently measure. Same with the connection pool having no acquire timeout, and the serial indexing loop. Those weren't decisions I made; they were defaults I accepted, and the senior version of this answer is admitting that rather than dressing them up as choices. Where I *did* push back — and this is the more interesting half — is the trace sink. The first version persisted only two of the six event types the agent emits and ordered replay by the database's insert-time clock. That's the kind of thing AI-assembled code does: it handles the obvious cases and leaves a column orphaned. I caught it by reading the schema against the writer — a `tokens_used` column with no code path writing it — and rewrote it to capture all six events with the event's own timestamp. The dimension assertion is a smaller override of the same kind: it throws instead of coercing because I wanted it loud, not 'helpfully' padded. So it's a mix: I overrode the tool where silence would hide a bug — and the trace sink is the clearest case of me not trusting AI-generated observability code until I'd read it against the schema — and I'm honest about the places I took its defaults without checking."

This is the most senior answer in the chapter, because it owns the third mode — defaulted-to — head on. Most candidates try to make every decision sound deliberate. Admitting "these were defaults I didn't evaluate, and here's the risk that creates" is rarer and reads as far more honest. The interviewer has heard a hundred people claim they evaluated everything. They've heard very few admit, precisely, where they didn't.

  ┃ "Owning a defaulted-to decision honestly is the
  ┃  riskiest mode to admit and the strongest signal
  ┃  when you do. Everyone claims they evaluated
  ┃  everything. Almost no one admits where they didn't."

```
  "Did you use AI?"
        │
        ▼  yes, heavily — here's the seam
        │
        ├─► IF THEY ASK "EXPLAIN A FILE LINE BY LINE"
        │     Pick pg-vector-store.ts — yours, deep, known
        │     cold. Don't try to defend library files at line
        │     granularity. Name the boundary.
        │
        ├─► IF THEY ASK "WHAT DID AI GET WRONG?"
        │     The defaulted-to decisions (ef_search, pool
        │     timeout). Own them as defaults, not choices.
        │     And name where you overrode it: the trace sink
        │     (caught it dropping 4 of 6 events + an orphaned
        │     column) and the fail-loud dimension check.
        │
        └─► IF THEY ASK "WHAT HAS AI TAUGHT YOU?"
              The judgment layer is the job now. The tools
              write the code; deciding what's right and
              knowing what you shipped is the skill that
              didn't get automated.
```

## What the tools have taught you — the closing note

The strongest version of the whole AI conversation ends on reflection, not defense. When the interviewer winds down the topic, leave them with what the tools actually changed about how you work:

> "What building this with AI taught me is that the bottleneck moved. The tools can produce the code faster than I can evaluate it, so the scarce skill isn't writing — it's judgment. Knowing which of the model's suggestions to accept, where to override it for a loud failure over a silent one, and being honest with myself about which decisions I actually evaluated versus which I just took. The discipline I came away with is the three-mode habit: for every decision, knowing whether it was mine, evaluated, or defaulted. That's the thing I'll carry forward — not faster typing, but a sharper sense of what I actually understand versus what I just accepted."

That's the answer that lands, because it reframes AI assistance from a thing to defend into a skill you've developed. You're not apologizing for using the tools; you're describing how using them well is itself the engineering.

## Strong vs. weak — the AI question

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK ANSWER                  │ STRONG ANSWER                │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "I mean, I used it a little  │ "Yes, heavily. AI helped      │
  │ for boilerplate but I wrote  │ assemble the code and a lot   │
  │ most of the real logic       │ of the cleverness is in the   │
  │ myself, the AI just helped   │ library I consume. What I     │
  │ with the easy parts."        │ brought is the judgment — and │
  │                              │ I can tell you for any        │
  │                              │ decision whether it was mine, │
  │                              │ evaluated, or a default I      │
  │                              │ didn't dig into."             │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ Defensive and minimizing.    │ Matter-of-fact, draws the     │
  │ "Just the easy parts" is a   │ exact seam, and introduces    │
  │ tell — it sounds like        │ the three modes. Owns the     │
  │ someone hiding how much they  │ AI's role AND the candidate's │
  │ leaned on it. The interviewer│ role without minimizing       │
  │ knows everyone uses AI; the   │ either. Reads as someone who  │
  │ minimizing reads as          │ thinks clearly about how they │
  │ insecurity.                  │ work.                        │
  └──────────────────────────────┴──────────────────────────────┘

The weak answer's fatal move is minimizing — "just the easy parts." It signals insecurity, and an interviewer who knows everyone uses AI heavily reads the minimizing as a small dishonesty. The strong answer doesn't minimize anything. It states the division of labor plainly and frames the judgment layer as the real work. Honesty about the scale of AI's role is what makes the ownership credible.

## What you'd change

The AI-honesty change you'd make is to keep a decision log as you build — a running note of which mode each decision was made in, in real time, rather than reconstructing it for an interview. The hardest part of the three-mode framework isn't the interview; it's being honest *with yourself* in the moment about whether you actually evaluated something or just accepted the default. A decision log forces that honesty while it's fresh, and it would make the "what did AI get wrong" answer come from notes instead of memory. That's the practice you'd carry into the next project — not just using AI well, but tracking your own judgment about it as you go.

## One-page summary

**Core claim:** The AI question tests whether you can own what you shipped, not whether you used AI. Be matter-of-fact, draw the exact seam, and name the mode each decision was made in.

**The questions, one line each:**
- *"Did you use AI?"* → Yes, heavily. AI assembled the code, the cleverness is largely in the library I consume; I brought the judgment and integration, and I can name the mode of every decision.
- *"Explain a file line by line."* → Pick pg-vector-store.ts — mine, deep, known cold. Name the boundary at library files; don't fake authorship.
- *"What did AI get wrong?"* → The defaulted-to decisions (ef_search, pool timeout) I didn't evaluate; and where I overrode it — caught the trace sink dropping 4 of 6 events + an orphaned column and rewrote it, plus the fail-loud dimension check.
- *"What did it teach you?"* → The bottleneck moved from writing to judgment. Knowing what I understand versus what I accepted is the skill.

**The three modes:** deliberate (own it), evaluated-and-accepted ("AI suggested, I checked it"), defaulted-to (riskiest to admit, strongest when owned).

**Pull quotes:**
- "The question isn't whether you used AI. It's whether you can name, for every decision, which mode it was made in."
- "Owning a defaulted-to decision honestly is the riskiest mode to admit and the strongest signal when you do."

**What you'd change:** Keep a decision log in real time — track which mode each decision was made in as you build, not reconstructed for the interview.

---

Updated: 2026-06-24 — folded the Ink/React chat REPL and the injected memory engine into the "what I built vs wired" division; made the trace-sink fix the concrete "where I overrode AI's default" story (read the schema against the writer, caught the orphaned column and the dropped events). The three-mode framework itself is unchanged.

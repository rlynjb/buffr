# Chapter 8 — The AI Question

This is the 2026 meta-question, and every senior interviewer asks some version of it: "Did you
use AI to build this?" "Can you explain this section line by line?" "What did the AI get wrong?"
The interviewer already assumes you used AI heavily — everyone does. They're not testing *whether*
you used it. They're testing whether you understand what you shipped well enough to own it. The
worst possible answer is defensive or evasive. The best possible answer is grounded: matter-of-
fact about the AI's role, matter-of-fact about yours, ending on what the tools actually taught you.

The posture that wins runs through all three modes of decision-making. Some choices you made
deliberately. Some the AI suggested and you evaluated and accepted. A couple you defaulted to —
the tool's default, never independently evaluated. Naming which mode each decision was, honestly,
is the whole game. The defaulted-to ones are the riskiest to own and the most senior-positive
when owned cleanly.

## What AI did, what I did

This is the chapter's anchor: the split. Know which side of this line every part of buffr sits on.

```
  buffr — what AI did vs what I did, and the decision mode

  ┌─ I DECIDED (deliberate) ───────────────────────────────────────────┐
  │  build aptkit as a library, consume not edit it                     │
  │  local-first / on-device — my data, own the stack                   │
  │  the @aptkit/memory extraction & the engine-up/store-down boundary  │
  │  the dropped chunks→documents FK (contract parity + memory rows)    │
  │  full-signal trace capture — all 6 CapabilityEvent types            │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ AI SUGGESTED, I EVALUATED & ACCEPTED ─────────────────────────────┐
  │  pgvector over Pinecone (weighed: op-simplicity vs hosted)          │
  │  HNSW with the cosine opclass (checked the operator alignment)      │
  │  the jsonb-stringify fix for the array-literal bug (understood why) │
  │  ContextWindowGuardedProvider wrapping the model (8192 cap)         │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ DEFAULTED TO (AI's default, I didn't deeply evaluate) ────────────┐
  │  HNSW index parameters — all defaults, never tuned                  │
  │  connection pool sizing — pg.Pool defaults (max 10, no timeouts)    │
  │  chunk size — fixed ~512 chars, never tuned against the eval        │
  │  READ COMMITTED isolation — whatever Postgres defaults to           │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ WHAT AI GOT WRONG / I HAD TO FIX ─────────────────────────────────┐
  │  array-as-jsonb: driver mis-cast arrays to PG array literals        │
  │  created_at ordering: concurrent flush raced; I persist event ts    │
  │  the silent empty-query path: still open — I know the fix           │
  └─────────────────────────────────────────────────────────────────────┘
```

The third box is the one that takes courage and earns the most credit. Name those out loud.

## "Did you use AI to build this?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Did you use AI to build this?"                              │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Not whether you used it — they assume you did. They're        │
│   testing your POSTURE. Defensive ("only for boilerplate")     │
│   reads as insecure. Evasive reads as hiding something.         │
│   Matter-of-fact, with a clear line between the AI's role and   │
│   yours, reads as someone who owns their work.                 │
└─────────────────────────────────────────────────────────────────┘
```

> "Yes, heavily — like everyone shipping in 2026. I'll be precise about the split, because that's
> the part that matters. The architecture decisions were mine: building aptkit as a consumable
> library, going local-first, extracting the memory engine and injecting the store back into it,
> dropping the documents foreign key to enable memory rows. Those are choices I can defend on their
> merits because I made them on their merits.
>
> Some choices the AI suggested and I evaluated and accepted — pgvector over Pinecone is the clearest
> one. The tool proposed it; I evaluated it against a hosted vector DB on operational simplicity and
> cost at my scale, and accepted it. I'd make that call the same way by hand.
>
> And there are a couple I'll own honestly as *defaults* I didn't deeply evaluate: the HNSW index
> parameters are all defaults, the connection pool is unconfigured, the chunk size is a fixed 512
> characters I never tuned against my eval set. None of those bite at single-operator scale, but I
> didn't make them as decisions — I took the defaults, and I know exactly which ones I'd have to turn
> into real decisions the moment the system grew."

That answer does the thing the question is actually fishing for: it shows you can sort your own
codebase into the three modes without flinching, and the honesty about the defaults is what
separates you from a candidate who claims they reasoned through every line.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I used it a little,    │ "Yes, heavily. The      │
│ mostly for boilerplate  │ architecture was mine.  │
│ and autocomplete, but   │ Some choices the AI     │
│ I wrote the important   │ suggested and I         │
│ parts myself."          │ evaluated — pgvector.   │
│                         │ And a few I'll own as   │
│                         │ defaults I didn't       │
│                         │ deeply evaluate — HNSW  │
│                         │ params, pool sizing.    │
│                         │ Here's which is which." │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Defensive and almost    │ Matter-of-fact, no      │
│ certainly untrue in     │ defensiveness, and it   │
│ 2026. "Only boilerplate"│ sorts the codebase into │
│ signals insecurity and  │ deliberate / evaluated /│
│ invites the interviewer │ defaulted. Owning the   │
│ to test the claim by    │ defaults is the         │
│ asking you to explain a │ strongest part — it's   │
│ line you can't.         │ what honesty looks like.│
└─────────────────────────┴─────────────────────────┘
```

> ┃ They're not testing whether you used AI. They're testing
> ┃ whether you can sort your own codebase into what you decided,
> ┃ what you evaluated, and what you defaulted to.

## "Explain this section line by line"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Pull up the PgVectorStore — explain the search method line   │
│    by line."                                                    │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   The direct ownership test. Can you explain code you shipped   │
│   in your own words, with the mechanism, not just read it       │
│   aloud? This is where the "I only used AI for boilerplate"     │
│   candidate falls apart and the grounded one shines.           │
└─────────────────────────────────────────────────────────────────┘
```

Pick the `search` method in `PgVectorStore` — it's small, it's yours, and you can walk it cold:

> "Sure. `search` takes a query vector and a `k`. First line: `assertDim` — it throws if the vector
> isn't 768-dimensional, because a dimension mismatch must fail loud, never silently truncate; that
> assertion exists in four places as defense-in-depth.
>
> Then the query. I select the id, content, and meta, plus a computed score: `1 - (embedding <=> $1)`.
> The `<=>` operator is pgvector's cosine *distance*, so I subtract from one to turn it into a
> similarity score where higher is better. I filter `where app_id = $2` — that's the tenant
> discriminator, shape-only today, no RLS behind it. I order by the same `<=>` distance and limit to
> `k`. The order-by is what lets the HNSW index get used — and it only gets used because the index was
> built with the matching `vector_cosine_ops` opclass. If those didn't align, this same query would
> silently fall back to a sequential scan: correct, but slow.
>
> Last thing: I rebuild the meta shape on the way out — I fold `document_id`, `chunk_index`, and
> content back into a `meta` object so the search tool's citations work, because the in-memory store
> the contract is modeled on returns that shape. The vector goes in as a text literal — `toVectorLiteral`
> joins the number array into pgvector's `[0.1,0.2,...]` format — bound as a parameter, so there's no
> string-concatenation SQL injection path."

That walkthrough names the mechanism (cosine distance → similarity), the load-bearing correctness
fact (opclass alignment), the security property (parameterized), and the contract reason for the
meta reshape. That's ownership, not recitation.

```
"Explain search line by line."
      │
      ▼
You walk assertDim → cosine SELECT → opclass alignment → meta reshape.
      │
      ├─► IF THEY ASK "why 1 minus the distance?"
      │     "<=> is cosine DISTANCE — 0 is identical, larger is farther.
      │      I want a similarity score where higher is better, so I
      │      subtract from one. It's a presentation choice; the ordering
      │      is by raw distance either way."
      │
      ├─► IF THEY ASK "what if the opclass were wrong?"
      │     "Silent sequential scan. No error — the query still returns
      │      correct results, just without the index, so it's slow. It's
      │      the single most important thing to get right in a pgvector
      │      deployment, and the easiest to get silently wrong."
      │
      └─► IF THEY ASK "is this injection-safe?"
            "Yes — every value is a bound parameter, $1 through $3. The
             one serialized-to-text value is the vector literal, and that's
             a number array the embedder produced, length-checked by
             assertDim. No attacker-controlled string reaches the query."
```

## When they push past your depth

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "You said HNSW. Explain how the HNSW graph    ║
║   actually finds nearest neighbours — the layers, the     ║
║   search descent, why it's approximate."                  ║
║                                                           ║
║   You picked HNSW on defaults and the numbers held up.    ║
║   You have NOT gone deep on the graph internals — this is ║
║   the thin-ice region from chapter 6.                     ║
║                                                           ║
║   Say:                                                    ║
║   "I haven't gone deep into HNSW's internals — I picked   ║
║    it on operational defaults and my retrieval numbers    ║
║    held up. The shape I understand: it's a layered graph  ║
║    where search starts coarse at the top and descends to  ║
║    finer layers, and it's APPROXIMATE because it doesn't  ║
║    visit every node — it trades a small recall loss for a ║
║    huge speed win versus an exact scan. The exact         ║
║    construction — the m and ef parameters and how they    ║
║    trade recall against build time — I know are the knobs ║
║    but I haven't tuned them, because I never had to. If   ║
║    you want to dig into the descent, can you start me     ║
║    off?"                                                  ║
║                                                           ║
║   What this signals: confidence about what you know (the  ║
║   approximate-vs-exact tradeoff, that params exist), no   ║
║   fake confidence about the internals, and willingness to ║
║   learn in real time. The 2026 version of this is also    ║
║   honest about WHY you didn't go deeper: you didn't have  ║
║   to, and you know when you would.                        ║
║                                                           ║
║   Do NOT say:                                             ║
║   "It's some kind of graph thing that finds close nodes,  ║
║    I think." — vague hedging in territory you didn't go   ║
║   deep on is the surest way to fail. Name the boundary    ║
║   cleanly instead.                                        ║
╚═══════════════════════════════════════════════════════════╝
```

## What the tools actually taught you — the closer

End the chapter, and the interview, on reflection. This is the line that lands.

> "What building with AI heavily actually taught me is that the bottleneck moved. The bottleneck
> isn't typing the code anymore — it's *judgment*: knowing which suggestion to accept, which to
> push back on, and which default is about to bite you later. The pgvector suggestion was right and
> I could tell it was right. The dropped foreign key, the AI would have flagged as a smell — and I
> kept it deliberately because I understood what it bought me. The silent empty-query failure is one
> the tools didn't catch and I had to find by reasoning about the system, not by reading the code
> they wrote. Using AI well made me a better evaluator of decisions, because that's the part that's
> left for me to do."

> ▸ The bottleneck moved from typing the code to judging the
>   suggestions. Owning the judgment is the job now.

That closer reframes the whole AI question from defensive to forward-looking — it tells the
interviewer you've thought about what your role *is* in an AI-assisted workflow, which is exactly
the meta-skill a senior AI-engineering role is hiring for.

## What you'd change about how you answer the AI question

The reconsideration here is about your own instinct early in the pivot: the urge to *minimize* the
AI's role to sound more competent. That instinct is backwards in 2026 — minimizing reads as
insecurity, and it sets a trap, because the interviewer can always ask you to explain a line and
expose the gap. The stronger posture, the one this chapter trains, is to *maximize honesty about
the split* — be precise about what was deliberate, evaluated, and defaulted — because the precision
itself is the competence signal.

## One-page summary

**Core claim:** The interviewer assumes you used AI heavily; they're testing whether you can own
what you shipped. Sort your codebase into three modes — deliberate, evaluated-and-accepted,
defaulted-to — name the defaults honestly, explain your real code in your own words with the
mechanism, and close on what the tools taught you about judgment.

**Questions covered:**
- *"Did you use AI?"* → yes, heavily; architecture was mine, pgvector was evaluated-and-accepted,
  HNSW params / pool sizing / chunk size were defaults I didn't deeply evaluate.
- *"Explain search line by line."* → assertDim → cosine distance to similarity → opclass alignment
  (the silent-seq-scan risk) → meta reshape for citations → parameterized, injection-safe.
- *"How does HNSW work internally?"* → name the approximate-vs-exact tradeoff and the layered
  descent shape; admit you picked it on defaults and didn't tune the params.

**Pull quotes:**
- "They're not testing whether you used AI. They're testing whether you can sort your own codebase
  into what you decided, what you evaluated, and what you defaulted to."
- "The bottleneck moved from typing the code to judging the suggestions. Owning the judgment is the
  job now."

**What you'd change:** Stop the instinct to minimize the AI's role — in 2026 that reads as
insecurity and sets a trap. Maximize honesty about the split instead; the precision is the
competence signal.

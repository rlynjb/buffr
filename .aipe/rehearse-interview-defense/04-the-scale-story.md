# Chapter 4 — The Scale Story

"What breaks first at 10x?" tests whether you can reason about a system you haven't actually stressed. You built `buffr-laptop` for one user on one machine — it was never under load, and you should say so plainly. But the senior skill isn't having run a load test; it's being able to walk the bottlenecks in order, name what you'd add and when, and say how you'd measure to know. An interviewer doesn't expect you to have scaled a single-device app. They expect you to know *where it would crack* and to not pretend you've already solved problems you haven't met.

Here's the honesty calibration for this chapter, straight from your portfolio: you've shipped local-first apps and on-device AI, but you have not built distributed systems at horizontal scale, queue infrastructure, or multi-region anything. So this chapter teaches you to reason forward about scale *without* claiming you've operated it. When the interviewer pushes into Kafka-shaped territory, Chapter 4's job is to get you to the honest boundary gracefully, not to fake your way across it.

```
  WHAT BREAKS FIRST — bottlenecks in firing order

  load grows ───────────────────────────────────────────►

  10x CORPUS         100x CORPUS          10x CONCURRENT ASKS
  (more docs)        (huge index)         (many callers)
       │                  │                      │
       ▼                  ▼                      ▼
  ┌──────────────┐  ┌──────────────┐     ┌──────────────────┐
  │ #1 SERIAL    │  │ #1 HNSW recall│     │ #1 NO POOL ACQUIRE│
  │ INDEXING     │  │ untuned       │     │ TIMEOUT — waits   │
  │ files run    │  │ ef_search at  │     │ forever, doesn't  │
  │ one at a time│  │ default; no   │     │ fail fast         │
  └──────┬───────┘  │ recall floor  │     └────────┬─────────┘
         │          └──────┬───────┘              │
         ▼                 ▼                       ▼
  ┌──────────────┐  ┌──────────────┐     ┌──────────────────┐
  │ #2 N+1 chunk │  │ #2 app_id    │     │ #2 Gemma is the   │
  │ INSERT loop  │  │ post-filter  │     │ real ceiling —    │
  │ per-row,     │  │ on HNSW under-│     │ one model, serial │
  │ not batched  │  │ fills k       │     │ generation        │
  └──────────────┘  └──────────────┘     └──────────────────┘

  HOW YOU'D KNOW: EXPLAIN ANALYZE the search · exact-scan
  recall baseline · time the embed vs generate vs query split
```

The chart is the chapter. Three scale scenarios across the top, the first two bottlenecks for each below, and the measurement discipline along the bottom. Walk it left to right and you've answered the scale question.

## Scenario 1 — 10x the corpus

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "You go from indexing a few notes to indexing your     │
  │    whole document history. What breaks first?"          │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know where YOUR code is the bottleneck versus   │
  │   where Postgres is? Can you name the first thing to     │
  │   crack, not just "it gets slow"?                       │
  └─────────────────────────────────────────────────────────┘

> "The first thing to crack is indexing throughput, and it's in my code, not Postgres. I index files serially — the loop awaits each file's full embed-and-upsert before starting the next, so the GPU sits idle during every commit. Within a single document the embedding is already batched into one call, so that's fine; the waste is across files. The fix is a bounded concurrency limit — process three or four files in parallel instead of one — and only the loop changes. The second bottleneck behind that is the chunk insert: I upsert chunks one row at a time inside the transaction, which is the classic N+1, just atomic. A multi-row INSERT or COPY collapses it to one statement. Both are negligible on localhost today, which is why I haven't done them — they only matter once the corpus is big enough that index time is felt."

Decision mode honesty: the serial indexing is something you **defaulted to** — the straightforward loop — and never optimized because at your scale it didn't matter. Owning that it's a default, not a considered choice, is the move.

  ┃ "The first bottleneck is almost always in your own
  ┃  code, not the database. Know which of your loops is
  ┃  the N+1."

```
  "What breaks first at 10x corpus?"
        │
        ▼  serial indexing
        │
        ├─► IF THEY ASK "WHY NOT FIX IT NOW?"
        │     It's invisible on localhost — the embed call
        │     dominates, not the loop overhead. Optimizing it
        │     now is solving a problem I don't have.
        │
        ├─► IF THEY ASK "HOW WOULD YOU FIX IT?"
        │     Bounded parallelism across files (a pLimit of
        │     3-4), and a multi-row INSERT for chunks. Loop
        │     changes only; the contract stays the same.
        │
        └─► IF THEY ASK "WHAT WOULD YOU MEASURE?"
              Time the three phases separately — embed,
              insert, commit — to confirm the embed is the
              real cost before parallelizing anything.
```

## Scenario 2 — 100x the corpus

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Now the index has a hundred times more vectors.       │
  │    What happens to retrieval?"                          │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you understand that your ANN index is approximate   │
  │   and that recall degrades silently? Do you have a way   │
  │   to even detect the degradation?                       │
  └─────────────────────────────────────────────────────────┘

> "The risk at a large index is silent recall loss. HNSW is approximate, and the recall knob — `ef_search` — is at the default, which I never tuned because I don't have a recall baseline. A bigger graph with too-low `ef_search` would start missing true nearest neighbors, and nothing in my system would tell me, because my eval scores precision and recall against the *approximate* results, with no exact baseline to compare to. So before I trusted retrieval at that scale, the first thing I'd build is an exact-scan baseline — force Postgres to skip the index and compute true nearest neighbors — then compare and tune `ef_search` to a recall target. The second thing that bites at scale is the tenant filter: the `app_id` WHERE clause and the HNSW order-by don't compose inside one index, so Postgres walks the graph and then post-filters `app_id`, which can under-fill k once there are many tenants. The fix there is a partial or partitioned index per tenant — but that's only when there's a second tenant, which there isn't yet."

The killer move here is admitting the measurement gap: your eval can't currently detect a recall regression because it has no ground truth. Naming the gap *and* the experiment that closes it is the senior signal. Anyone can say "I'd tune the index." Knowing you can't even *measure* whether it needs tuning yet is rarer.

## Scenario 3 — 10x concurrent requests

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What if ten people hit this at once instead of one?"  │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know what your single-user assumptions cost     │
  │   you the moment there's concurrency? Can you find the   │
  │   real ceiling versus the fixable bottleneck?           │
  └─────────────────────────────────────────────────────────┘

> "Two things, and they're different in kind. The fixable one: my connection pool has no acquire timeout. Today there's one caller so the pool never runs dry, but under concurrency an exhausted pool would wait forever for a connection instead of failing fast — that's the first thing I'd fix, and it's one option on the pool. The real ceiling, though, isn't the database — it's Gemma. I run one local model and generation is the dominant cost by an order of magnitude. Ten concurrent asks means ten serial generations through one model, so the database connection problem is almost a distraction next to the model being the throughput wall. If this were ever a real service, scaling generation — multiple model workers, or moving generation to a hosted endpoint — is the actual lever, not anything in my storage layer."

Decision mode: the missing pool timeout is a **defaulted-to** gap — node-postgres's defaults, which you never overrode because single-user never exposed it. Own it as a default.

  ┃ "Find the real ceiling before you optimize the
  ┃  fixable bottleneck. Mine is the model, not the
  ┃  database — and I'd be wrong to spend effort on the
  ┃  pool first."

## Strong vs. weak — the scale answer

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK ANSWER                  │ STRONG ANSWER                │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "I'd add caching and maybe   │ "First bottleneck is serial  │
  │ Redis, and scale the         │ indexing in my own loop —    │
  │ database horizontally, and    │ fixable with bounded         │
  │ add a load balancer, and use │ parallelism. The real        │
  │ a CDN…"                      │ ceiling is Gemma generation, │
  │                              │ which dominates wall-clock.   │
  │                              │ I'd measure the embed-vs-     │
  │                              │ generate split before         │
  │                              │ touching anything else."      │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ A grab-bag of scaling words  │ Names the FIRST bottleneck    │
  │ with no order and no         │ specifically, distinguishes  │
  │ measurement. "Add Redis" to  │ fixable from the real         │
  │ solve what? Caching would    │ ceiling, and leads with       │
  │ not even help the real       │ measurement. Shows you'd      │
  │ bottleneck (generation).     │ verify before optimizing.     │
  │ Signals pattern-matching,    │                              │
  │ not reasoning.               │                              │
  └──────────────────────────────┴──────────────────────────────┘

The weak answer is a list of scaling vocabulary. The strong answer is an *ordering* with a measurement plan. Notice the weak answer even reaches for caching — which wouldn't touch the actual ceiling, because the bottleneck is generation, not retrieval. Reaching for a fix that doesn't address the bottleneck is the clearest tell that someone is pattern-matching instead of thinking.

## When you don't know

This is the chapter where you're most likely to get pushed past your portfolio. The interviewer asks the distributed-systems-at-scale question, and you have not built that. Your portfolio is local-first apps and on-device AI — not Kafka, not multi-region, not load balancing under sustained traffic. This is the single question you're most likely to get pushed past your depth on, and the recovery has to be clean.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They push: "Okay, now make it multi-region with        ║
  ║   millions of users. How do you partition the data,      ║
  ║   handle replica lag, and keep writes consistent across  ║
  ║   regions?"                                              ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "That's outside what I've actually built. My           ║
  ║    portfolio is local-first and on-device systems —      ║
  ║    single-node, single-region. I haven't operated        ║
  ║    multi-region replication or partitioning under load,  ║
  ║    so I won't pretend to a design I've never tested. I    ║
  ║    can reason about the shape — you'd partition on a      ║
  ║    tenant key, accept that cross-region reads lag, and    ║
  ║    pick where you want consistency versus availability —  ║
  ║    but I'd be reasoning from reading, not from having     ║
  ║    shipped it. Where I'm strong is the single-node story  ║
  ║    and the local-first tradeoffs. Want to go there       ║
  ║    instead?"                                              ║
  ║                                                          ║
  ║   What this signals: you know the exact edge of your     ║
  ║   experience, you don't bluff across it, you can still   ║
  ║   reason about the shape honestly, and you redirect to   ║
  ║   your strength. A senior interviewer respects this far  ║
  ║   more than a confident wrong answer.                    ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "I'd use Kafka and shard the database and set up        ║
  ║    eventual consistency with a consensus protocol."      ║
  ║   Every one of those words invites a follow-up you       ║
  ║   can't answer, and the bluff unravels fast. Naming      ║
  ║   technologies you haven't used is the trap.             ║
  ╚═══════════════════════════════════════════════════════════╝

That box is the most important one in the book for you specifically. The scale question is where the interview most reliably pushes a local-first engineer into distributed-systems territory. The win condition is not crossing into it — it's stopping at the edge cleanly and redirecting to where you're actually strong.

  ┃ "I know the exact edge of my experience, and I'd
  ┃  rather name it than bluff across it."

## What you'd change

If you were building for scale from the start, the change you'd make first is instrumentation, not architecture. Right now you have almost no measurement: the tool layer computes a `durationMs` for every tool call, but the trace sink never reads it, and the eval scores retrieval against approximate results with no exact baseline. Before optimizing anything, you'd capture the latency breakdown — embed time, generate time, query time — and build the exact-scan recall baseline. You can't optimize what you can't measure, and the honest version of "what breaks first at 10x" is "I'd find out by measuring, because I haven't run it under load." That sentence, said calmly, beats any list of scaling technologies.

## One-page summary

**Core claim:** Walk the bottlenecks in firing order, distinguish the fixable bottleneck from the real ceiling, and lead with how you'd measure. You haven't run it under load — say so.

**The scenarios, one line each:**
- *10x corpus* → serial file indexing breaks first (fixable with bounded parallelism), then the N+1 chunk insert. Both in my code, not Postgres.
- *100x corpus* → silent HNSW recall loss; I can't even detect it without an exact-scan baseline, which is the first thing I'd build.
- *10x concurrent* → no pool acquire timeout is the fixable bug; the real ceiling is one Gemma model generating serially.
- *multi-region at millions* → outside my experience; I reason about the shape but won't claim a design I've never shipped.

**Pull quotes:**
- "The first bottleneck is almost always in your own code, not the database."
- "Find the real ceiling before you optimize the fixable bottleneck."
- "I know the exact edge of my experience, and I'd rather name it than bluff across it."

**What you'd change:** Add instrumentation first — the latency breakdown and the exact-scan recall baseline — because you can't optimize what you can't measure.

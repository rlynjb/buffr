# Chapter 4 — The Scale Story

"What breaks first at 10x?" is a forward-looking systems question, and it's the one chapter
where you have to be most careful — because buffr is a single-operator laptop app, and scale is
exactly the territory `me.md` flags as your honest gap. You have not built distributed systems
at horizontal scale, hot-path queues, or multi-region replication. So the move here is *not* to
bluff a distributed-systems answer. It's to reason precisely about where YOUR system breaks
first, name the bottleneck order correctly, and hand off cleanly to "I don't know" exactly when
the question leaves your built experience.

The counterintuitive truth that wins this chapter: for buffr, the first thing that breaks under
scale is **not** the database. It's the emulated tool call. Lead with that and you sound like
someone who knows their own system's real failure ordering, not someone reciting "add a cache,
add a read replica."

## The scale-bottleneck chart

This is the chapter's anchor: what breaks first as each axis grows, in order.

```
  buffr under load — what breaks first, by axis

  AXIS: more CORPUS (100x data — thousands → hundreds of thousands of chunks)
  ────────────────────────────────────────────────────────────────────────
    1st  HNSW recall vs latency   ← default ef params; recall drifts, build
                                     time climbs. Tune m / ef_construction /
                                     ef_search. Measurable, fixable.
    2nd  table + index bloat       ← every re-index upserts a NEW row version
                                     (MVCC), HNSW re-indexes on update. Vacuum
                                     can't keep up under heavy re-indexing.
    3rd  retrieval precision       ← more chunks = more near-duplicates = the
                                     right chunk ranks lower. Need reranking.

  AXIS: more CONCURRENT USERS (10x — 1 operator → many callers)
  ────────────────────────────────────────────────────────────────────────
    1st  the connection pool       ← pg.Pool max=10, unconfigured. A 2nd+
                                     writer contends immediately.
    2nd  Ollama serialization      ← ONE local model, one box. Concurrent
                                     requests queue behind one gemma2:9b.
    3rd  no tenant isolation       ← app_id is shape-only, no RLS. A real
                                     2nd tenant could read across the boundary.

  AXIS: more LATENCY-SENSITIVE requests (10x — interactive SLA pressure)
  ────────────────────────────────────────────────────────────────────────
    1st  generation latency        ← gemma2:9b on a laptop IS the latency.
                                     Retrieval is noise next to it.
    2nd  no streaming               ← answer() awaits the FULL response;
                                     stream:false. Perceived latency = full
                                     generation, no first-token feedback.
    3rd  the emulated tool call     ← extra round-trips when the model
                                     mis-emits the JSON and re-queries.

  ┌──────────────────────────────────────────────────────────────────────┐
  │  THE CEILING ABOVE ALL AXES: the emulated tool call.                  │
  │  gemma2 has no native tools. No arg-schema validation on the parse.   │
  │  Wrong key → empty query → silent garbage retrieval. This caps        │
  │  reliability before any throughput limit is reached.                  │
  └──────────────────────────────────────────────────────────────────────┘
```

Hold that bottom box. It's the answer that distinguishes you.

## "What breaks first at 10x?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What's the first thing that breaks if this gets 10x the      │
│    load?"                                                       │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Do you know your OWN system's failure ordering, or do you     │
│   reach for the generic answer ("add a cache, add a replica")?  │
│   Can you name the FIRST bottleneck, the SECOND, what you'd     │
│   add and when, and how you'd MEASURE to know? Forward-looking  │
│   systems thinking, grounded in this code.                     │
└─────────────────────────────────────────────────────────────────┘
```

> "It depends which axis grows, so let me be specific about the three. But I'll start with the
> answer that surprises people: for buffr, the database is not the first thing to break. The
> first ceiling is the emulated tool call. Gemma has no native tool-calling, so aptkit renders
> the tool schema into the prompt and parses a JSON object back out of the model's prose — and
> there's no argument-schema validation on that parse. If the model emits the wrong key, the
> query field comes back empty and the search silently returns whatever an empty string embeds
> to. That caps reliability before I ever hit a throughput wall.
>
> Now, if you mean concurrent users specifically: the first hard bottleneck is the connection
> pool. I create `pg.Pool` with no config, so it defaults to ten connections. One CLI user never
> touches that; a second and third writer contend immediately. Right behind it is Ollama — I run
> one local model on one box, so concurrent requests serialize behind a single gemma2:9b. That's
> a real wall: a local single-model deployment doesn't scale horizontally without putting the
> model behind something that can fan out.
>
> If you mean corpus size — 100x the documents — the first thing to move is HNSW recall versus
> latency. I'm on all default index parameters. As the corpus grows, recall drifts and build
> time climbs, and I'd tune the HNSW m and ef parameters against my eval set. The way I'd *know*
> is the eval I already have: precision@k and recall@k on a labeled query set. If recall@k starts
> dropping as I add data, that's the signal the index needs tuning."

That answer does four things the question asks for: names the first bottleneck per axis, the
second, what you'd add, and how you'd measure. And it grounds every one in a real file or a real
default — the pool, the Ollama box, the HNSW params, the eval.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd add caching and a  │ "Depends on the axis.   │
│ load balancer, and      │ For users: the pool     │
│ scale the database      │ (default max 10), then  │
│ horizontally with read  │ Ollama serializing on   │
│ replicas."              │ one model. For corpus:  │
│                         │ HNSW recall vs latency, │
│                         │ measured by my          │
│                         │ recall@k eval. The real │
│                         │ ceiling above all of it │
│                         │ is the emulated tool    │
│                         │ call."                  │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Generic scale checklist │ Grounded in THIS        │
│ that fits any system    │ system's real defaults  │
│ and names nothing in    │ and ordering, with a    │
│ THIS one. An            │ measurement signal      │
│ interviewer hears       │ named. Surprises with   │
│ "I read a blog post."   │ the right answer (tool  │
│ Read replicas don't     │ call, not DB) — proof   │
│ even apply — there's    │ you know your own       │
│ one writer.             │ system.                 │
└─────────────────────────┴─────────────────────────┘
```

> ┃ The generic scale answer — "cache, replica, load balancer" —
> ┃ fits every system and describes none. Name YOUR system's
> ┃ first bottleneck instead.

## "How would you make the model scale?"

This is where the question walks straight into your honest gap, and the chapter has to be
disciplined about it.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "Okay, you've got one Ollama box serializing  ║
║   requests. How do you scale model serving to thousands   ║
║   of concurrent users? Walk me through the inference      ║
║   infrastructure — batching, GPU pooling, autoscaling,    ║
║   a queue in front."                                      ║
║                                                           ║
║   This is distributed-systems-at-scale and hot-path queue ║
║   infrastructure — exactly the territory you have NOT     ║
║   built. dryrun, contrl, AdvntrCue, buffr are all         ║
║   single-device or serverless. You've never run inference ║
║   infra under sustained load.                             ║
║                                                           ║
║   Say:                                                    ║
║   "Here's where I hit the edge of what I've actually      ║
║    built. I've shipped local-first and serverless — buffr,║
║    dryrun, contrl, AdvntrCue — but I have not run model-  ║
║    serving infrastructure under sustained concurrent load.║
║    I can reason about the shape: you'd put the model      ║
║    behind a request queue so callers don't block on one   ║
║    box, batch inference to use the GPU efficiently, and   ║
║    pool replicas behind a balancer with autoscaling on    ║
║    queue depth. But I'd be reasoning from first           ║
║    principles, not from production scars — I haven't       ║
║    operated continuous batching or GPU autoscaling. If    ║
║    you want to go deeper, I'd rather learn the real        ║
║    tradeoffs from you than pretend I've tuned them."      ║
║                                                           ║
║   What this signals: a clean boundary between what you've ║
║   shipped and what you've only read, the ability to       ║
║   reason about the shape anyway, and zero fake confidence ║
║   in infra you've never run. All three are senior.        ║
║                                                           ║
║   Do NOT say:                                             ║
║   "You'd just add more GPUs and a load balancer and       ║
║    Kafka in front." — name-dropping Kafka and GPUs as if  ║
║    you've tuned them, when you haven't, is the single     ║
║    fastest way to fail a senior interview. A good          ║
║    interviewer asks "what batch size?" and it collapses.  ║
╚═══════════════════════════════════════════════════════════╝
```

This is the question most likely to push you past your depth, and the recovery above is the one
to rehearse until it's automatic. The move is: name the boundary, reason about the shape, refuse
the fake scar.

```
"Scale the model serving."
      │
      ▼
You name the boundary and reason about the shape.
      │
      ├─► IF THEY PUSH ON BATCHING SPECIFICS
      │     "I haven't tuned continuous batching. I understand the
      │      tradeoff is throughput vs per-request latency — bigger
      │      batches use the GPU better but make individual requests
      │      wait. The exact knobs I'd have to learn on the job."
      │
      ├─► IF THEY ASK "what would YOU reach for?"
      │     "For buffr specifically I'd flip to a hosted inference API
      │      before I built serving infra — it's a personal tool, not
      │      a product. Building the infra would be solving a problem
      │      I don't have."
      │
      └─► IF THEY ASK ABOUT THE DATABASE UNDER THAT LOAD
            Back on home ground: "Now the unconfigured pool and the
             single Postgres instance matter. I'd size the pool, add a
             read replica for the retrieval reads, and that's a pattern
             I've reasoned about even if I haven't run it at scale."
```

## What you'd change for scale

The honest forward move — the one you'd volunteer — is that buffr's scale story is deliberately
unbuilt, and the *first* thing you'd add isn't infrastructure, it's measurement. Today you have
precision@k and recall@k but no latency instrumentation and no load test. Before you tuned a
single HNSW parameter or sized the pool, you'd add timing around the retrieval and generation
steps so you could see which one actually dominates under your real corpus — because right now
you're reasoning that generation dominates retrieval, and you'd want to prove it rather than
assert it. You don't optimize what you haven't measured.

## One-page summary

**Core claim:** buffr's first scale bottleneck is the emulated tool call, not the database. Name
the real bottleneck order per axis, ground each in a real default, name the measurement signal —
and hand off cleanly to "I don't know" the moment the question reaches inference infrastructure
at scale, which you haven't built.

**Questions covered:**
- *"What breaks first at 10x?"* → ceiling is the emulated tool call; for users it's the pool
  (default 10) then Ollama serialization; for corpus it's HNSW recall, measured by recall@k.
- *"How would you scale model serving?"* → name the boundary (never run inference infra), reason
  about the shape (queue, batching, pooling), refuse the fake scar.
- *"Database under that load?"* → home ground: size the pool, read replica for retrieval reads.

**Pull quotes:**
- "The generic scale answer — 'cache, replica, load balancer' — fits every system and describes
  none. Name YOUR system's first bottleneck instead."
- "The reliability ceiling is the emulated tool call, not the database."

**What you'd change:** Add latency instrumentation before any scale work — you reason that
generation dominates retrieval, but you'd prove it with timing rather than assert it. Don't
optimize what you haven't measured.

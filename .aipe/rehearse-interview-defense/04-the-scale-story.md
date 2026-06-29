# Chapter 4 — The Scale Story

"What breaks first at 10x?" is the question where frontend-pivot
candidates either show systems thinking or fold. You haven't operated
distributed systems at horizontal scale — that's the honest gap from
`me.md`, and this chapter is built around defending it without faking
it. The move is not to invent a scaling architecture you've never run.
The move is to reason crisply about *what breaks first, in what order*,
for the system you actually built — and to be honest about where your
ability to reason runs out.

The good news: buffr's bottlenecks are knowable from the code. You don't
need scale experience to say "the single stateful process is the first
thing that won't scale horizontally" — that's a reading of the
architecture, and you can do that with confidence.

## The scale-bottleneck chart

This is the chapter's anchor: as you grow each axis, what breaks, in
what order. Memorize the *sequence*, not the numbers.

```
  what breaks first — three scale axes

  AXIS                 1st bottleneck          2nd bottleneck
  ───────────────────  ──────────────────────  ───────────────────────
  10x CORPUS           HNSW recall + build     synchronous per-doc
  (~10k+ chunks)       degrades on default     indexing (runtime.ts:17)
                       m / ef_construction      → batch reindex
                            │
                            ▼ tune index, then batch indexing

  2nd WRITER           app_id isolation        full-priv DATABASE_URL
  (app #2 / phone)     is by CONVENTION,       held in the client
                       no RLS → wrong-tenant   process → scope the
                       reads possible           credential
                            │
                            ▼ RLS + token-derived app_id (HARD gate)

  10x LATENCY-         single stateful         no timeouts / retries /
  SENSITIVE REQS       process: one chat       fallback on Gemma + DB
                       session = one process,  → a hung Ollama stalls
                       not behind an LB         the turn, no recovery
                            │
                            ▼ stateless service behind an LB (rearchitect)
```

Three axes, three first-bottlenecks. Walk them one at a time.

---

### Scenario 1 — 10x the corpus

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What happens when you have 10x the documents? A hundred     │
│    thousand chunks instead of a few thousand?"                  │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you know where YOUR system's data-size ceiling is, and    │
│   can you name the bottleneck precisely — or do you just say   │
│   "I'd add caching"? They want a specific first failure, not   │
│   a generic answer.                                             │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Two things degrade, in order. First, the HNSW index. I built it on
> pgvector's default `m` and `ef_construction`, which are fine for a few
> thousand chunks, but past roughly 10k both recall and index build time
> degrade — the graph gets denser to search and slower to build. The fix
> isn't a new database; it's tuning those parameters or rebuilding the
> index with higher `ef_construction` for better recall at the cost of
> build time. Second, my indexing is synchronous and per-document —
> `indexDocumentRow` writes the doc row then indexes its chunks inline,
> one document at a time. That's fine for a hand-loaded corpus, but at
> 10x it's a real bottleneck, and the plan is to batch the reindex past
> that point. How I'd know I hit it: my retrieval eval — precision@1 and
> recall@3 — would drop, and index build time would climb. The eval set
> is the instrument."

This is a strong scale answer because it names a *specific first
bottleneck* (HNSW default params), the *second* (synchronous indexing,
`src/runtime.ts:17`), the fix for each, and — critically — *how you'd
measure to know you hit it* (the eval scores). That last part is the
senior move: you don't just predict the bottleneck, you name the
instrument that would catch it.

```
  ┃ Don't just name the bottleneck — name the instrument that
  ┃ tells you you've hit it. For the corpus, that's the
  ┃ retrieval eval dropping.
```

#### The follow-up tree off the corpus scenario

```
  You give the HNSW-then-indexing answer.
        │
        ├─► IF THEY ASK "tune HNSW how, specifically?"
        │     → Raise ef_construction for better recall at the cost of
        │       build time, and m for graph connectivity. I'd sweep
        │       against the eval set, not guess. (Own that I took the
        │       default first — see chapter 8.)
        │
        ├─► IF THEY ASK "why is indexing synchronous?"
        │     → It was fine for a hand-loaded corpus — indexDocumentRow
        │       writes the doc row then indexes chunks inline. Past ~10k
        │       chunks I'd batch the reindex; the plan already flags
        │       that threshold.
        │
        └─► IF THEY ASK "would you ever leave pgvector for this?"
              → Not for corpus size alone — I'd tune the index first.
                I'd only switch if tuning ran out, and I'm nowhere near
                that. It's a watch item, not a regret.
```

---

### Scenario 2 — a second writer (the real one)

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "How would this work for multiple users? Or even just a      │
│    second app writing to the same database?"                    │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you know the difference between data that LOOKS isolated  │
│   and data that IS isolated? The app_id column is a trap —     │
│   it looks like multi-tenancy. Do you know it isn't enforced?  │
└─────────────────────────────────────────────────────────────────┘
```

This is the scenario you should *want*, because the honest answer here
is a strong signal: you know your isolation is shape-only.

The strong answer:

> "Here's the trap in my own schema: every table has an `app_id` column,
> default `'laptop'`, and it *looks* like multi-tenancy. It isn't. There's
> no RLS, and `app_id` is set by the application code — it's not derived
> from a verified token. So with one user that's correct and clean, but
> the moment a second app or a phone writes to that database, isolation
> is enforced only by the app remembering to filter on `app_id`. A bug or
> a hijacked process could read another tenant's rows. That's why the
> design treats RLS as a *hard prerequisite* before a second writer — not
> a nice-to-have. The jump is two parts: `app_id` has to become
> token-derived, extracted from a verified session instead of an env
> default, and the database has to enforce it with row-level security
> instead of trusting the app to pass the right value. The schema already
> carries the column, so the shape is pre-built; what's missing is the
> enforcement. And the related risk: the client holds a full-privilege
> `DATABASE_URL` — fine on my own laptop, but off the laptop that one
> string is the whole castle, so it'd need to become a scoped, short-lived
> credential."

That answer demonstrates you understand the *difference between a column
existing and a constraint being enforced* — which is exactly what the
question probes. You're not apologizing for the missing RLS; you're
naming it as a deliberate deferral with a hard, named trigger
(`sql/001_agents_schema.sql` has no policies; the gate is in the
graduation spec).

#### Weak vs strong — the second-writer scenario

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "It supports multiple       │ "It LOOKS multi-tenant —    │
│ tenants — every table has   │ every table has app_id —    │
│ an app_id column so the     │ but it isn't enforced.      │
│ data's separated by         │ There's no RLS and app_id   │
│ tenant."                    │ is set by the app, not      │
│                             │ token-derived. With one     │
│                             │ user that's fine; at a      │
│                             │ second writer it's the      │
│                             │ first thing to fix — RLS +  │
│                             │ token-derived app_id. The   │
│                             │ column is shape; the         │
│                             │ enforcement is missing."    │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ This is the trap, and the   │ Catches its own trap. Knows │
│ candidate walked into it.   │ a column is not a           │
│ Claiming isolation that     │ constraint. Names the       │
│ isn't enforced is worse     │ deferral as deliberate with │
│ than admitting it's not     │ a hard trigger. This is the │
│ there — it reads as not     │ exact answer that turns a   │
│ understanding RLS at all.   │ "gap" into a signal.        │
└─────────────────────────────┴─────────────────────────────┘
```

```
  ┃ A column is not a constraint. app_id LOOKS like tenancy;
  ┃ without RLS and a token-derived value, it's only shape.
  ┃ Knowing that difference is the whole answer.
```

---

### Scenario 3 — 10x latency-sensitive requests

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What if you had ten times the request volume, and latency   │
│    mattered? How does this hold up?"                            │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand why your system can't scale horizontally   │
│   as-is? Can you name the stateful bottleneck — or do you      │
│   reach for "add more servers" without seeing that nothing     │
│   here is stateless?                                            │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer — and this is where you defend the gap directly:

> "Honestly, this is the axis furthest from what I've built, so let me be
> precise about what I can and can't reason about. The first thing that
> breaks: nothing here is stateless-behind-a-load-balancer. A chat
> session is a single stateful Node process — it holds one warm pool and
> one conversation in-process across turns. You can't just put ten of
> those behind a load balancer and round-robin, because the state lives
> in the process. To scale horizontally I'd have to externalize that
> session state and make the request path stateless, which is a
> rearchitecture, not a config change. The second bottleneck: there are
> no timeouts, retries, or fallback on the Gemma and database calls, so
> under load a single hung Ollama call stalls a turn with no recovery.
> Beyond naming those two, I'd be speculating — I haven't operated a
> service under sustained traffic, so I'm not going to invent a sharding
> story. What I CAN tell you is exactly why the current shape is
> single-stateful and what the first rearchitecture would target."

That is the model answer for a gap you can't fake: name the first
bottleneck precisely (single stateful process), name the second
(no timeouts/retries), and then *explicitly mark the edge of your
knowledge* and stop. Stopping is the senior move. Inventing a Kafka
topology is the junior one.

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   This whole chapter is the territory. The deepest push:     ║
║   "OK, so how WOULD you make it stateless and scale it out?   ║
║   Walk me through the distributed design." This is           ║
║   distributed-systems-at-scale — genuinely not in your        ║
║   portfolio.                                                  ║
║                                                               ║
║   Say:                                                        ║
║   "That's past where I've actually built. I can give you the ║
║    shape — externalize the session state so the request path ║
║    is stateless, put the stateless workers behind a load     ║
║    balancer, and the database becomes the shared state with  ║
║    RLS enforcing tenant isolation. But the parts that need   ║
║    real production scars — connection pooling under          ║
║    sustained load, replication and read consistency, where   ║
║    the hot path actually melts — I haven't operated, so I'd  ║
║    be guessing at the details. I'd rather tell you that than ║
║    sketch a diagram I can't defend."                          ║
║                                                               ║
║   What this signals: you can reason to the SHAPE of the       ║
║   distributed design, you know exactly which parts require    ║
║   experience you don't have, and you stop cleanly at that     ║
║   line. An interviewer trusts the candidate who marks the     ║
║   boundary over the one who bluffs across it.                 ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I'd shard the database, add Redis for caching, use Kafka   ║
║    for the write path, set up multi-region replication..." —  ║
║   a shopping list of infra you've never run. One follow-up    ║
║   ("why Kafka and not a simpler queue?") and it collapses.    ║
╚═══════════════════════════════════════════════════════════════╝
```

This box covers the single most likely question to push you past your
depth in the whole book — see the note in the overview. The defense is
the same every time: reason to the shape, mark the edge, stop.

---

### What you'd change for scale

The one thing in the current code that I'd change *now*, before any real
scale, is the missing timeouts and retries on the model and database
calls. It's the cheapest reliability win and it's the first gap that
would bite even at modest remote use — a hung Ollama call currently
stalls a turn with no recovery. Everything else on the scale path (RLS,
statelessness, batch indexing) is correctly deferred behind a real
trigger; the timeouts are the one I'd pull forward, because they're low
cost and the absence is a genuine reliability hole, not just a
scale-phase concern.

---

## One-page summary — Chapter 4

**Core claim:** Reason crisply about what breaks first in *your* system,
name the instrument that catches it, and mark the edge of your knowledge
cleanly instead of inventing a distributed design.

**The three scenarios:**

- **10x corpus** — 1st: HNSW default params degrade recall + build past
  ~10k chunks (tune, don't switch). 2nd: synchronous per-doc indexing
  (`runtime.ts:17`) → batch reindex. Instrument: the retrieval eval.
- **2nd writer** — 1st: `app_id` is shape-only, no RLS, not
  token-derived → wrong-tenant reads. 2nd: full-priv `DATABASE_URL` in
  the client. The hard gate before any second writer.
- **10x latency reqs** — 1st: single stateful process, not behind an LB
  (rearchitecture to externalize session state). 2nd: no
  timeouts/retries/fallback on Gemma + DB.

**Pull quotes:**

```
  ┃ Name the instrument that tells you you've hit the
  ┃ bottleneck — for the corpus, the retrieval eval dropping.

  ┃ A column is not a constraint. app_id is shape, not tenancy,
  ┃ until RLS enforces it.
```

**The "I don't know":** The full distributed design — reason to the
shape (externalize state, stateless workers, LB, RLS), name the parts
that need production scars you don't have, stop. Never recite an infra
shopping list.

**What you'd change:** Pull timeouts/retries on Gemma + DB calls forward
— cheapest reliability win, the one gap that bites even at modest remote
use.

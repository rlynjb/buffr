# Chapter 5 — The Failure Story

"What happens when things go wrong?" is the operational-thinking question. It's not asking whether your code works on the happy path — it's asking whether you've thought about the unhappy ones. Network drops, the model goes down, malformed input, partial writes, a tool call that fails silently. The strong candidate has walked the failure surfaces of their own system and can say, for each one, exactly what happens — including the cases where the honest answer is "it crashes, and here's why that's acceptable for a single-user CLI, and here's what I'd add before it wasn't."

`buffr-laptop` makes a clear, defensible bet: it's fail-fast. There are no retries, no timeouts, no circuit breakers. When something breaks, the awaited promise rejects and the command throws. For an interactive single-user CLI that's the right call — the operator sees the error and re-runs. But you have to be able to name the one place where fail-fast becomes fail-*forever*, and own it.

```
  THE FAILURE MAP — every surface and what happens

  ┌─ INPUT BOUNDARY ──────────────────────────────────────────┐
  │  missing DATABASE_URL  → throws "DATABASE_URL is not set"  │
  │  empty question        → throws usage error               │
  │  wrong embed dimension → assertDim THROWS (never truncate) │
  └───────────────────────────────────────────────────────────┘
  ┌─ EXTERNAL HOPS (the danger zone) ─────────────────────────┐
  │  Ollama down    → fetch ECONNREFUSED, raw stack trace     │
  │  Ollama HANGS   → ⚠ no timeout, no AbortSignal — the CLI  │
  │                    freezes forever. nothing cancels it.    │
  │  Postgres down  → pool.query rejects, command throws      │
  │  pool exhausted → ⚠ waits forever (no acquire timeout)    │
  └───────────────────────────────────────────────────────────┘
  ┌─ WRITE PATH ──────────────────────────────────────────────┐
  │  chunk upsert fails  → ROLLBACK, transaction atomic       │
  │  crash mid-index     → ⚠ document row, no chunks          │
  │                         (two txns, not one)               │
  │  trace write fails   → surfaces only at flush(), after    │
  │                         the answer already printed         │
  └───────────────────────────────────────────────────────────┘
  ┌─ MODEL / AGENT LAYER ─────────────────────────────────────┐
  │  Gemma returns bad JSON → emulation retries once, capped  │
  │  wrong tool arg key     → ⚠ searches empty string SILENTLY│
  │  model finds nothing    → abstains: "say so plainly"      │
  │  loop won't stop        → forced synthesis turn           │
  └───────────────────────────────────────────────────────────┘
```

Read the map for the ⚠ marks. The unmarked lines are handled well — atomic transactions, fail-loud assertions, forced abstention. The marked ones are the honest gaps, and each one is a question you should be ready to own rather than dodge.

## The big one: external hops with no timeout

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What happens if Ollama is slow or hangs partway       │
  │    through a request?"                                  │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Have you thought about the difference between a         │
  │   failure (something errors) and a hang (something       │
  │   never returns)? Do you know your system has no way     │
  │   to cancel a stuck external call?                      │
  └─────────────────────────────────────────────────────────┘

> "If Ollama is *down*, the fetch rejects with a connection-refused error and the command throws — that's fine, fail-fast, the operator sees it and re-runs. The case I'd flag is if Ollama *hangs* — stalls partway and never responds. I set no timeout on the embedding or generation calls and no AbortSignal, so there's nothing to cancel a stuck call. The CLI just freezes. For a single-user interactive tool that's tolerable — I notice it's hung and kill it with Ctrl-C — but it's the first thing I'd fix before this became a service, because in a service a hung upstream call ties up a worker indefinitely. The fix is an AbortSignal with a timeout on each external hop, which is also the only way to make a retry meaningful — you can't retry a call you can't cancel."

Decision mode honesty: the missing timeouts are **defaulted-to**. You didn't decide "no timeouts"; you just never added them, because single-user never made a hang into a real problem. The senior move is owning that it was a default, then immediately showing you understand *why* it would matter in a different deployment.

  ┃ "Fail-fast is the right default for a CLI. The bug
  ┃  is the one path that's actually fail-forever — a
  ┃  hung call with nothing to cancel it."

```
  "What if Ollama hangs?"
        │
        ▼  no timeout, the CLI freezes
        │
        ├─► IF THEY ASK "WHY NO TIMEOUT?"
        │     Single-user interactive tool — I see the freeze
        │     and Ctrl-C it. A timeout buys nothing when
        │     there's a human watching. It's a defect the
        │     moment there's no human in the loop.
        │
        ├─► IF THEY ASK "HOW WOULD YOU ADD IT?"
        │     An AbortSignal with a deadline on each fetch and
        │     each pg query. That's also the prerequisite for
        │     retries — you can't retry what you can't cancel.
        │
        └─► IF THEY ASK "RETRIES TOO?"
              Yes, but second. Timeout first to bound the
              wait, then bounded retry with backoff for the
              transient-failure case. Order matters.
```

## The silent failure: wrong tool argument key

This is the failure mode that's genuinely subtle, and naming it unprompted is a strong signal because most people don't know it exists.

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "Your model has no native tool-calling — it's          │
  │    emulated. What happens when the model gets the tool   │
  │    call slightly wrong?"                                │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know the failure modes of YOUR specific setup?  │
  │   Emulated tool-calling has a silent-failure class that  │
  │   native APIs don't. Do you know where it bites?        │
  └─────────────────────────────────────────────────────────┘

> "There's a silent-failure class here that's specific to emulation. The model is supposed to reply with a JSON object naming the tool and its arguments. If the JSON is malformed, the provider retries once with a corrective nudge, capped, so a model returning slightly-off JSON can't loop forever. But here's the gap: the emulation doesn't validate the arguments against the tool's schema. So if the model puts the search query under the wrong key — say `q` instead of `query` — parsing succeeds, the tool runs, but the handler coerces the missing `query` to an empty string and searches for nothing. No error. It just retrieves badly and the model answers from thin context. That's the reliability ceiling of running a weak model with emulated tools, and the fix has to live in my own wrapper, since I can't edit the library — schema-validate the arguments before the tool runs."

Decision mode: this is an **evaluated-and-accepted** limitation. You understand it's there, you know why (the library doesn't validate args), and you know it can only be fixed on your side of the boundary. That's the senior framing — you didn't miss it, you understand its shape and the constraint that leaves it open.

  ┃ "Emulated tool-calling moves the schema guarantee
  ┃  from generation-time to parse-time — and parse-time
  ┃  enforcement is always best-effort. The silent case
  ┃  is a wrong key searching empty string."

## The handled cases — say these with confidence

Not every failure surface is a gap. Several are handled well, and you should claim them firmly because they show you thought about failure on the write path and the model path.

**Atomic chunk writes.** The chunk upsert runs inside a `BEGIN`/`COMMIT` on one pinned connection, with a `ROLLBACK` on any error. If one chunk insert fails, none of them land — the transaction is all-or-nothing. Say: *"The chunk write is atomic — it's one transaction on a pinned connection, rolls back on failure, so I never get a half-indexed document's chunks."*

**Fail-loud on dimension mismatch.** `assertDim` throws if any vector's length doesn't match 768 — before any read or write. It never pads or truncates. Say: *"A dimension mismatch throws immediately rather than silently corrupting the index, because a truncated vector would index fine and retrieve wrong forever."*

**Forced abstention.** The system prompt tells the model to say so plainly when the knowledge base doesn't contain the answer, rather than guessing. Say: *"When retrieval comes back empty, the model is instructed to abstain rather than fill the gap from pre-training. Grounding fails silently without that branch."*

**The agent can't loop forever.** Covered in Chapter 2 — the forced synthesis turn. Say: *"The loop can't hang on the model's indecision; it's bounded and the final turn removes the tools."*

These four are your confidence anchors in this chapter. When the interviewer is probing failure, lead with one of these to establish that you *did* think about failure, then be honest about the ⚠ gaps.

## The partial-write gap

  ┌─────────────────────────────────────────────────────────┐
  │ THEY ASK                                                 │
  │   "What if the process crashes in the middle of          │
  │    indexing a document?"                                │
  │                                                         │
  │ WHAT THEY'RE TESTING                                     │
  │   Do you know your write path isn't fully atomic across  │
  │   the document and its chunks? Can you say why that's    │
  │   tolerable and what you'd do about it?                 │
  └─────────────────────────────────────────────────────────┘

> "There's a gap I'd own here. Indexing writes the `documents` row in one transaction, then the chunks in a separate one — they're not atomic together. A crash between them leaves a document row with no chunks. It's tolerable for two reasons: the corpus is re-derivable, since I can just re-run `index` on the same file, and re-indexing is idempotent because the chunk ids are deterministic, so it overwrites cleanly rather than duplicating. But it's the dual-write problem in miniature, and the fix is to thread one pinned connection through both writes so the document and its chunks commit together. One change, and it's the highest-leverage one in the write path — it also closes the orphan-chunk case at the same time."

Decision mode: **deliberate** tradeoff. You accepted non-atomicity because the data is re-derivable and the writer is single-threaded. That's a real reason, not laziness — say it that way.

## Strong vs. weak — the failure answer

  ┌──────────────────────────────┬──────────────────────────────┐
  │ WEAK ANSWER                  │ STRONG ANSWER                │
  ├──────────────────────────────┼──────────────────────────────┤
  │ "It handles errors fine, it  │ "Fail-fast by design — most  │
  │ has try-catch and it throws  │ errors reject the promise    │
  │ if something goes wrong, so  │ and the command throws, which │
  │ it's pretty robust."         │ is right for a CLI. The one  │
  │                              │ path I'd flag: a hung Ollama │
  │                              │ call has no timeout and       │
  │                              │ nothing to cancel it, so the  │
  │                              │ CLI freezes. That's the first │
  │                              │ thing I'd fix for a service." │
  ├──────────────────────────────┼──────────────────────────────┤
  │ Why it's weak:               │ Why it works:                │
  │ "Handles errors fine" and    │ Names the design (fail-fast), │
  │ "pretty robust" are          │ says why it's right HERE,     │
  │ assertions, not knowledge.   │ then names the ONE specific   │
  │ Banned word, too. Shows no   │ gap and when it would matter. │
  │ awareness of the difference  │ Distinguishes a failure from  │
  │ between a failure and a      │ a hang. That distinction is   │
  │ hang.                        │ the senior signal.            │
  └──────────────────────────────┴──────────────────────────────┘

The weak answer uses the word "robust," which is banned for a reason — it's a claim with no content behind it. The strong answer never claims robustness; it describes the actual behavior and names the one place that behavior breaks. Describing beats asserting, every time.

## When you don't know

In the failure chapter, you can get pushed into operational territory you've never run — observability under production load, incident response, alerting. You've never operated a service with on-call.

  ╔═══════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                       ║
  ║                                                          ║
  ║   They ask: "In production, how would you know this      ║
  ║   failure happened? What's your alerting and incident    ║
  ║   response?"                                             ║
  ║                                                          ║
  ║   Say:                                                   ║
  ║   "I haven't run this as a production service, so I       ║
  ║    don't have real incident-response experience to       ║
  ║    point to. What I can tell you is what observability   ║
  ║    I have and what's missing: the system captures the    ║
  ║    full agent trajectory to Postgres — every turn, every ║
  ║    tool call — so I can replay what happened after the    ║
  ║    fact. What it doesn't do yet is capture error and     ║
  ║    warning events, so a run that hit an error looks       ║
  ║    identical in the store to a clean one. That's a false ║
  ║    negative, and it's the first observability gap I'd     ║
  ║    close — capture errors before I worry about alerting." ║
  ║                                                          ║
  ║   What this signals: you don't claim ops experience you  ║
  ║   lack, you pivot to the observability you DID build,     ║
  ║   and you name a specific, real gap in it. Pivoting to    ║
  ║   the true thing is stronger than guessing at the         ║
  ║   unknown thing.                                         ║
  ║                                                          ║
  ║   Do NOT say:                                            ║
  ║   "I'd set up PagerDuty and Prometheus and SLOs and       ║
  ║    Grafana dashboards."                                  ║
  ║   Naming tools you've never wired invites "walk me        ║
  ║   through your SLO definition," and you're done.         ║
  ╚═══════════════════════════════════════════════════════════╝

## What you'd change

The failure-handling change you'd make first is the trace sink's blind spot. The sink captures the agent's trajectory, but it only handles two of the six event types — it drops error and warning events entirely. So the worst case, a run that failed, is invisible: it looks identical in the store to a clean run. That's worse than no logging, because a scrambled or incomplete trace reads as authoritative. You'd add branches for the error and warning events first — before timeouts, before retries — because the ability to *see* a failure is the prerequisite for handling it. Observability before resilience.

## One-page summary

**Core claim:** The system is fail-fast, which is right for a CLI. Lead with the handled cases (atomic writes, fail-loud assertions, forced abstention), then own the one path that's actually fail-forever.

**The failure surfaces, one line each:**
- *Ollama hangs* → no timeout, no AbortSignal, CLI freezes. Tolerable with a human watching; first fix for a service.
- *Wrong tool arg key* → emulation doesn't validate args; searches empty string silently. Fix in my wrapper.
- *Crash mid-index* → document row without chunks (two transactions, not one). Tolerable because re-derivable + idempotent; fix is one transaction.
- *Trace write fails* → surfaces only at flush, after the answer prints. Trajectory loss is non-fatal to the answer.
- *Handled well* → atomic chunk upsert (rollback), dimension mismatch throws, forced abstention, bounded loop.

**Pull quotes:**
- "Fail-fast is the right default for a CLI. The bug is the one path that's actually fail-forever."
- "Emulated tool-calling moves the schema guarantee from generation-time to parse-time."

**What you'd change:** Capture error and warning events in the trace sink first — a failure you can't see is worse than no logging. Observability before resilience.

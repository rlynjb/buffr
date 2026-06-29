# Chapter 5 — The Failure Story

"What happens when things go wrong?" tests operational thinking — do you
think about the unhappy path, or only the demo path? buffr is
single-device, so most distributed failure modes genuinely don't apply,
and the strong move is to say that cleanly rather than invent failures to
sound thorough. But the failures that *do* exist in this codebase are
handled with deliberate, named choices — best-effort memory,
transactional rollback, fail-fast guards — and those choices are the
material. This chapter walks the failure surfaces that are real and
names exactly what the system does at each.

The discipline: for each failure surface, state what the system does
*today*, name whether that's a deliberate containment or an honest gap,
and never dress a gap as a feature.

## The failure-mode map

Each box is a failure surface; the annotation is what the system
actually does. Notice the split — some are contained by design, some are
honest gaps with a named trigger to close them.

```
  failure surfaces — and what the system does

  ┌─ CONTAINED BY DESIGN ───────────────────────────────────────────┐
  │                                                                  │
  │  memory-write fails    ──► try/catch swallows it; the answer     │
  │  (session.ts:64-69)        the user already has is never lost    │
  │                            (asymmetric durability, on purpose)   │
  │                                                                  │
  │  mid-batch upsert fail ──► BEGIN…ROLLBACK; no half-indexed doc   │
  │  (pg-vector-store:59-62)   the whole batch rolls back            │
  │                                                                  │
  │  wrong-dim vector      ──► assertDim THROWS before any SQL runs; │
  │  (pg-vector-store:32)      never silently truncates              │
  │                                                                  │
  │  agent.ask throws      ──► rendered as an error turn in the TUI; │
  │  (chat.tsx:30-32)          the session survives, keeps running   │
  │                                                                  │
  │  missing DATABASE_URL  ──► throws at startup, not mid-run        │
  │  (session.ts:37)           fail-fast on config                   │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ HONEST GAPS (named trigger to close) ──────────────────────────┐
  │  Ollama unreachable    ──► agent call throws → error turn.       │
  │                            NO fallback chain. aptkit HAS a       │
  │                            provider-fallback; buffr doesn't      │
  │                            compose it.                           │
  │                                                                  │
  │  trace flush insert    ──► Promise.all rejects; that turn's      │
  │  fails (trace-sink:91)     trajectory is PARTIAL, no retry       │
  │                                                                  │
  │  Gemma emits wrong     ──► missing query coerced to '' → empty   │
  │  tool arg key              search → ungrounded answer (the       │
  │                            dominant failure mode)                │
  └──────────────────────────────────────────────────────────────────┘
```

Walk the questions an interviewer asks against this map.

---

### Question 1 — "What happens when the model is down?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What happens if Ollama is down, or the model call hangs?    │
│    Does the whole thing fall over?"                             │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you know your own failure behavior, including the parts   │
│   you DIDN'T harden? A candidate who claims graceful           │
│   degradation they didn't build gets caught. They want the     │
│   honest behavior and whether you know how to close the gap.   │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "If Ollama is unreachable, the agent's model call just throws, and that
> propagates up to `session.ask`, which the TUI catches and renders as an
> error turn — so the session itself survives and stays interactive, but
> that turn fails with no recovery. I want to be straight about what's
> NOT there: there's no timeout, no retry with backoff, and no fallback
> chain. Interestingly, aptkit *has* a provider-fallback pattern — I just
> don't compose it in buffr, because for one local user with Ollama on
> the same machine, a down model means I have a bigger problem than a
> retry would fix. The gap is real and I know exactly how I'd close it:
> a timeout on the model call plus a retry, and for a remote deployment,
> wire the provider fallback. It's the first reliability work I'd do
> before any non-local use."

The strength is the honesty: you name that the session *survives*
(`src/cli/chat.tsx:30-32` renders the error turn) but the turn *fails
without recovery*, you name what's missing (timeouts, retries,
fallback), and you name that aptkit even has the fallback you didn't
wire. That last detail proves you know the gap is a choice, not an
ignorance.

```
  ┃ The session survives a failed turn; the turn doesn't
  ┃ recover. Naming both halves precisely beats claiming a
  ┃ resilience you didn't build.
```

#### Weak vs strong — the model-down answer

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "It handles that            │ "The agent call throws and  │
│ gracefully — if the model   │ the TUI renders it as an    │
│ is down it retries and      │ error turn, so the session  │
│ falls back, so the user     │ survives but that turn       │
│ still gets a response."     │ fails with no recovery.     │
│                             │ There's no timeout, retry,  │
│                             │ or fallback — aptkit HAS a  │
│                             │ provider-fallback I just     │
│                             │ don't compose, because for  │
│                             │ one local user a down model │
│                             │ is a bigger problem than a  │
│                             │ retry fixes. It's the first │
│                             │ reliability work I'd do."    │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ It claims resilience that   │ Names the real behavior     │
│ isn't in the code. One      │ (session lives, turn dies), │
│ follow-up — "show me the    │ names exactly what's        │
│ retry" — and it collapses.  │ missing, and shows you know │
│ Inventing graceful          │ the gap is a choice (the    │
│ degradation is worse than   │ fallback exists, you didn't │
│ admitting the gap.          │ wire it). Honest and        │
│                             │ in-control.                 │
└─────────────────────────────┴─────────────────────────────┘
```

---

### Question 2 — "What if a write fails halfway through?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "When you index a document and write its chunks, what        │
│    happens if it fails partway? Do you get a half-indexed       │
│    document?"                                                    │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand transactional boundaries? Partial-write    │
│   handling is the classic operational-correctness probe. They  │
│   want to hear "atomic batch, rollback" — or to catch you not  │
│   having thought about it.                                      │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "No half-indexed document — the upsert is atomic. In `PgVectorStore`,
> all the chunks for a document are dimension-checked first, then the
> whole batch runs inside an explicit `begin … commit`, with a `rollback`
> on any error. So if chunk 7 of 10 fails to insert, the transaction
> rolls back and none of them land — the document either indexes
> completely or not at all. And the dimension check runs *before* the
> transaction even opens, so a wrong-size vector fails fast without
> touching the database at all. The one durability asymmetry worth
> naming, since it's the opposite choice: conversation memory is
> best-effort. A memory-write failure is swallowed in a try/catch,
> because the answer the user already has must never be lost to a memory
> bookkeeping failure. So indexing is all-or-nothing transactional;
> memory is fire-and-forget. Different guarantees, on purpose, because
> they protect different things."

This is a strong answer because it shows you understand transactional
atomicity (`src/pg-vector-store.ts:38-65`) *and* that you made a
*deliberately different* durability choice for memory
(`src/session.ts:64-69`) — and you can articulate *why* the asymmetry
exists (the answer is the product; memory is a bonus). Naming the
contrast is what proves it's deliberate.

#### The follow-up tree

```
  You give the atomic-batch answer.
        │
        ├─► IF THEY ASK "why is memory best-effort but indexing isn't?"
        │     → Different things protected. Indexing is the corpus —
        │       a half-indexed doc corrupts retrieval. Memory is a
        │       bonus written AFTER the answer is delivered; losing it
        │       costs nothing the user sees. Asymmetric on purpose.
        │
        ├─► IF THEY ASK "what about the trajectory writes — atomic too?"
        │     → No, and this is an honest gap. The trace flush is a
        │       Promise.all over queued inserts; one failed insert
        │       leaves a partial trajectory with no retry. Since the
        │       trajectory is the portfolio artifact, that's the
        │       failure handling I'd most want to harden.
        │
        └─► IF THEY ASK "what if the dimension is wrong?"
              → assertDim throws BEFORE the transaction opens — the
                768-dim embedding one-way door, made a loud failure
                instead of a silent truncation.
```

---

### Question 3 — "What about bad input — can a user break it?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What stops malformed input — a weird question, an injection │
│    attempt — from breaking the system or leaking data?"         │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you understand your trust boundaries and your injection   │
│   surface? For an AI app specifically — do you know where      │
│   prompt injection can enter, and is the blast radius bounded? │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "Two things to separate: SQL injection and prompt injection. SQL is
> resistant everywhere — every query that touches user- or model-derived
> data uses parameterized placeholders, the value never becomes part of
> the SQL string. Even the vector search binds the query vector as a
> parameter and casts it; there's no string-built SQL in the repo. Prompt
> injection is the live one: indexed documents come back as tool results
> and re-enter the model's context, and now recalled conversation memory
> does too — so a poisoned passage, or a poisoned earlier turn that got
> remembered, could try to instruct the model. But the blast radius is
> small *by design*, and that's the part I want to emphasize: the agent
> is allowlisted to exactly one read-only tool — knowledge-base search —
> with a hard budget of four tool calls and six turns. So even if the
> model is fully talked into following injected instructions, the worst
> it can do is *search*. There's no write tool, no exec, no network
> egress to redirect. The model can be talked into a wrong *answer*; it
> can't be talked into an *action*. The honest gap: there's no
> content-level injection defense — no delimiting of retrieved text — and
> I don't add it yet precisely because the tool scope makes injection
> low-value. It becomes worth adding the day the agent gets a second,
> non-read-only tool."

This is a genuinely strong security answer for an AI role because it
distinguishes the two injection types, names the real one (prompt, via
retrieved content + recalled memory), and — the key move — defends the
*blast radius* with the least-privilege tool scope (one read-only tool,
bounded budget) rather than claiming a defense that isn't there. "Wrong
answer, not an action" is the line that lands.

```
  ┃ A least-privilege tool scope is a prompt-injection defense.
  ┃ The model can be talked into a bad answer but not into an
  ┃ action — because the only tool it has is read-only search.
```

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                          ║
║                                                              ║
║   The push here: "If two writes raced — say two processes    ║
║   indexing the same document at once — what happens? Walk    ║
║   me through the concurrency control." buffr is              ║
║   single-process single-writer, so you've never actually     ║
║   exercised concurrent writes, and the deep answer is        ║
║   Postgres MVCC internals you took on defaults.              ║
║                                                              ║
║   Say:                                                       ║
║   "In practice this never races today — it's one process,    ║
║    one writer. If two did race on the same chunk id, the     ║
║    upsert is ON CONFLICT DO UPDATE, so last-writer-wins on   ║
║    that row, and each batch is its own transaction so I'd    ║
║    lean on Postgres's MVCC for isolation. But I'll be        ║
║    honest — I took Postgres's default isolation level and    ║
║    I haven't had to reason about a real write-write conflict ║
║    in this system, because the architecture never produces   ║
║    one. The day a second writer exists, that's exactly the   ║
║    kind of thing I'd need to design for deliberately."       ║
║                                                              ║
║   What this signals: you know the relevant mechanism exists  ║
║   (ON CONFLICT, MVCC, isolation levels) and you're honest    ║
║   that the single-writer architecture means you haven't had  ║
║   to exercise it. Knowing the shape and owning the           ║
║   non-exercise beats inventing a conflict-resolution story.  ║
║                                                              ║
║   Do NOT say:                                                ║
║   "I use optimistic locking with version numbers..." — you   ║
║   don't; there's no version column. Claiming a concurrency   ║
║   control you didn't build is the fastest way to get caught. ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### What you'd change about failure handling

The failure handling I'd most want to change is the trajectory flush.
Everything user-facing is contained well — best-effort memory, atomic
indexing, error turns that keep the session alive — but the trace sink's
`Promise.all` over queued inserts means one failed insert leaves a turn's
trajectory partial, with no retry. Since the entire portfolio thesis is
"capture every trajectory now so fine-tuning is answerable later," a
silently-partial trajectory is the failure that undercuts the project's
own goal. I'd either write the trace events inside the same transaction
as the answer, or add a retry on the queued inserts. It's acceptable for
one local user, but it's the gap I'd close first, because of what the
trajectory is *for*.

---

## One-page summary — Chapter 5

**Core claim:** Single-device means most distributed failures don't
apply — say that cleanly. The failures that exist are handled with
deliberate, named choices; never dress a gap as a feature.

**The questions covered:**

- **"Model down?"** — Agent call throws → error turn; session survives,
  turn doesn't recover. No timeouts/retries/fallback (aptkit has
  fallback; buffr doesn't compose it). Honest gap, named.
- **"Partial write?"** — Atomic batch: `BEGIN…ROLLBACK`, no half-indexed
  doc; `assertDim` throws before the transaction. Memory is deliberately
  the opposite — best-effort, swallowed.
- **"Bad input / injection?"** — SQL: parameterized everywhere, resistant.
  Prompt injection: real (retrieved docs + recalled memory), but blast
  radius bounded by a one read-only tool, 4-call budget. Wrong answer,
  not an action.

**Pull quotes:**

```
  ┃ The session survives a failed turn; the turn doesn't recover.

  ┃ A least-privilege tool scope IS a prompt-injection defense —
  ┃ talked into a bad answer, never into an action.
```

**The "I don't know":** Concurrent write-write conflicts — name the
mechanisms (ON CONFLICT, MVCC, default isolation), own that the
single-writer architecture never exercises them. Never claim optimistic
locking you didn't build.

**What you'd change:** Harden the trajectory flush — `Promise.all` over
queued inserts gives partial capture on one failure, and the trajectory
is the portfolio artifact.

# Chapter 5 — The Failure Story

"What happens when things go wrong?" tests operational thinking — whether you've considered the
failure surfaces, or only the happy path. buffr has a small, well-bounded set of failure modes
precisely because it's single-operator and read-only downstream, and that's a *defensible*
posture if you walk the surfaces deliberately. The win in this chapter is showing you know
exactly what the system does on each failure — not promising it handles everything, but naming
what it handles, what it doesn't, and why the blast radius stays small.

## The failure-mode map

Every failure surface as a box, with what the system actually does. This is the chapter's anchor.

```
  buffr — failure surfaces and the system's response

  ┌─ Ollama down / model unreachable ──────────────────────────────────┐
  │  agent.answer() throws → caught in chat.tsx onSubmit catch          │
  │  → surfaced as "error: <message>" to the operator's own TTY         │
  │  RESPONSE: turn fails visibly, session survives, no partial state   │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ DB unreachable / read-only ───────────────────────────────────────┐
  │  pool.query throws → propagates up through ask() → same catch        │
  │  RESPONSE: turn fails visibly. NO retry, NO circuit breaker today.   │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ malformed tool call (THE big one) ────────────────────────────────┐
  │  Gemma emits wrong JSON key → query field empty → search runs on    │
  │  an empty-string embedding → returns garbage, SILENTLY               │
  │  RESPONSE: NO error. Wrong-but-confident answer. The worst failure   │
  │  because it's invisible. No arg-schema validation on the parse.      │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ memory write fails ───────────────────────────────────────────────┐
  │  memory.remember() throws → try/catch in session.ts SWALLOWS it      │
  │  RESPONSE: the answer is already returned to the user. By design —   │
  │  a memory failure must never lose the answer. Best-effort.          │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ partial write on index (crash mid-index) ─────────────────────────┐
  │  documents row written (txn 1), crash before chunks (txn 2)         │
  │  RESPONSE: orphaned document, no chunks. Dropped FK = no complaint.  │
  │  Reconcile by re-indexing. Non-atomic across two transactions.      │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ dimension mismatch (wrong embedding model) ───────────────────────┐
  │  vector length ≠ 768 → assertDim THROWS, loudly, in 4 places         │
  │  RESPONSE: fails fast and visibly. Never silently truncates. The     │
  │  ONE failure the system is aggressively defended against.            │
  └─────────────────────────────────────────────────────────────────────┘
```

Two of those boxes are the ones to lead with: the silent malformed tool call (the worst, and
honest to name) and the dimension mismatch (the one you defend hardest). They show you've
thought about both the failure you can't see and the one you refuse to let pass.

## "What happens when the LLM is down?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "What happens when the model API is down or times out?"       │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Did you handle the dependency failure, or assume the model    │
│   is always there? Do you degrade gracefully, fail loudly, or   │
│   hang? And do you know the difference between what you BUILT   │
│   and what you'd ADD?                                           │
└─────────────────────────────────────────────────────────────────┘
```

> "Ollama is a hard dependency — it's local, on the loopback, so 'down' usually means I didn't
> start it. When the model is unreachable, `agent.answer()` throws, and that propagates up through
> `session.ask()` to the catch block in `chat.tsx`'s `onSubmit`, which renders it as an error turn
> in the chat — `error:` plus the message. So the turn fails visibly, the session survives, and
> there's no partial state: I persisted the user message before calling the agent, but no
> assistant answer gets written for a failed turn.
>
> What I have NOT built is retry or a circuit breaker — there's no backoff on a transient Ollama
> hiccup. For a local single-operator tool that's acceptable; the operator sees the error and
> retries by hand. If this were serving other people, I'd add a retry-with-backoff around the
> model call and a circuit breaker so a sustained outage fails fast instead of making every turn
> wait for a timeout. aptkit has the seam for it — the model provider is a port — so it's an
> adapter-level change, not a rewrite."

The honesty move: name what you built (visible failure, no partial state), name what you didn't
(retry, circuit breaker), and name *why the absence is acceptable here* and *what would change
it*. That's operational maturity without overclaiming.

```
"What happens when the model is down?"
      │
      ▼
You give the throws → caught → visible-error answer.
      │
      ├─► IF THEY ASK "why no retry?"
      │     "Single operator, local model — a retry loop on a model I
      │      forgot to start just delays the error I want to see. On a
      │      product I'd add backoff + a breaker; the provider port is
      │      the place to put it."
      │
      ├─► IF THEY ASK "what about a partial answer mid-stream?"
      │     "Can't happen here — answer() awaits the full response,
      │      stream:false. There's no half-written answer to clean up.
      │      That's also why there's no first-token feedback — a real
      │      tradeoff I'd revisit if I streamed." (ch 4, ch 7)
      │
      └─► IF THEY ASK "what does the user see?"
            "An error turn in the scrollback with the message. They're
             the operator — they own their own errors, so a verbose
             message is appropriate here, not a leak."
```

## "What's the worst failure — the one you can't see?"

This is the question that separates candidates who walked the happy path from those who walked
the failure surface. Volunteer the silent failure.

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Is there a failure mode that doesn't surface as an error?"   │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Do you know your system's SILENT failures — the ones that     │
│   return a confident wrong answer instead of throwing? Those    │
│   are the dangerous ones, and naming yours unprompted is a      │
│   strong signal.                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> "Yes, and it's the one I'd flag first. The tool call is emulated — Gemma has no native
> tool-calling, so aptkit parses a JSON object out of the model's prose. There's no
> argument-schema validation on that parse. If the model emits the wrong key — say it doesn't
> produce a `query` field — the query comes back empty, and the search runs on whatever an
> empty string embeds to. It returns chunks, they're just garbage, and the model answers from
> garbage. No error is thrown. The operator gets a confident, wrong answer with no signal that
> retrieval failed.
>
> That's the worst failure in the system precisely because it's invisible. The fix is
> argument-schema validation on the parsed call — reject or re-prompt when the required field is
> missing — and that's an aptkit-side change, in the emulated tool-call path. Until that's in, the
> mitigation is the eval: precision@k and recall@k catch *retrieval* regressions on the labeled
> set, but they don't catch a per-query empty-query event in production. That gap is real."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "It handles errors      │ "The dangerous one is   │
│ gracefully — if         │ silent: emulated tool   │
│ something fails it       │ calls have no arg-      │
│ shows an error          │ schema validation, so a │
│ message."               │ wrong key → empty query │
│                         │ → garbage retrieval →   │
│                         │ confident wrong answer, │
│                         │ no error thrown. Fix is │
│                         │ schema validation on     │
│                         │ the parse."             │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "handles errors         │ Names the exact silent  │
│ gracefully" is a claim  │ failure, the mechanism, │
│ with no mechanism, and  │ why it's invisible, the │
│ it ignores the failures │ fix, and the gap in the │
│ that DON'T throw — the   │ current mitigation.     │
│ ones that matter most.  │ This is what walking    │
│                         │ the failure surface     │
│                         │ sounds like.            │
└─────────────────────────┴─────────────────────────┘
```

> ▸ The failures that throw are the easy ones. The failure that
>   returns a confident wrong answer is the one worth naming first.

## When they push past your depth

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They ask: "Your index write spans two transactions and  ║
║   can crash in the middle. In a real distributed system   ║
║   how would you make that atomic — two-phase commit, a    ║
║   saga, an outbox? Walk me through the consistency        ║
║   protocol."                                              ║
║                                                           ║
║   Distributed-commit protocols are exactly the gap        ║
║   `me.md` names. You've reasoned about the two-transaction ║
║   write; you have NOT implemented 2PC, sagas, or an        ║
║   outbox in production.                                    ║
║                                                           ║
║   Say:                                                    ║
║   "For buffr the fix is simpler than a distributed        ║
║    protocol — both writes hit the same Postgres, so I'd    ║
║    wrap them in ONE transaction and the problem's gone. I  ║
║    split them because the documents write and the chunk     ║
║    upsert come from two different layers, not because they ║
║    had to be separate. As for true distributed-commit —    ║
║    sagas, two-phase commit, the outbox pattern — I know    ║
║    the shapes and the tradeoffs at a reading level, but I  ║
║    haven't operated them in production, so I'd be          ║
║    reasoning, not recalling. I'd rather say that than      ║
║    pretend I've run a saga orchestrator."                 ║
║                                                           ║
║   What this signals: you solve the problem you actually    ║
║   have with the tool you actually have (one transaction),  ║
║   and you draw a clean line at the distributed protocols   ║
║   you haven't run.                                         ║
║                                                           ║
║   Do NOT say:                                             ║
║   "I'd use a saga with compensating transactions." — said  ║
║   about a problem that's literally two writes to one DB,   ║
║   it signals you reach for the fancy pattern instead of    ║
║   the right one. The interviewer's next question buries    ║
║   you.                                                     ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change about failure handling

The reconsideration you'd volunteer is the retry-and-breaker gap around the model and database
calls. Today every dependency failure surfaces as a raw error turn — fine for an operator
debugging their own laptop, wrong for anything with a user who isn't you. The seam is already
there: the model and store are both ports in aptkit, so adding retry-with-backoff and a circuit
breaker is adapter-level work, not a rewrite. You'd sequence it *after* the argument-schema
validation, though — the silent garbage-retrieval failure is more dangerous than a loud model
timeout, so the invisible failure gets fixed first.

## One-page summary

**Core claim:** buffr's failure surfaces are small and bounded by design — single operator, one
read-only tool, best-effort memory. The win is naming the *silent* failure (emulated tool call →
empty query → garbage retrieval) unprompted, and being precise about what's handled (visible
failure, no partial state, loud dimension assert) versus what's deferred (retry, circuit
breaker).

**Questions covered:**
- *"What happens when the model is down?"* → throws → caught in onSubmit → visible error turn,
  session survives, no partial state. No retry/breaker yet; provider port is where they'd go.
- *"Any failure that doesn't throw?"* → yes, the worst one: emulated tool call with no arg-schema
  validation → empty query → silent garbage answer. Fix is schema validation on the parse.
- *"Make the two-transaction write atomic?"* → wrap both in one Postgres transaction; draw the
  line at distributed-commit protocols you haven't run.

**Pull quotes:**
- "The failures that throw are the easy ones. The failure that returns a confident wrong answer
  is the one worth naming first."
- "One read-only tool, capped turns, best-effort memory — small blast radius by design."

**What you'd change:** Add retry-with-backoff and a circuit breaker at the provider/store ports —
but sequence it *after* argument-schema validation, since the silent garbage-retrieval failure is
more dangerous than a loud model timeout.

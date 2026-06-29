# Chapter 7 — The Counterfactuals

"What would you do differently?" is the question where seniors separate
themselves by *volunteering* the answer. The senior-engineer move is to
name what you'd reconsider before being asked — it signals you're still
evaluating your own decisions, not defending them as finished. This
chapter walks the three or four most reconsiderable decisions in buffr
and shows what the strong counterfactual sounds like for each. The
anti-pattern, which this chapter actively guards against: fabricating
regrets for decisions that were obviously right. A counterfactual for a
correct decision reads as insecurity. Only reconsider what's genuinely
reconsiderable.

The discipline: a real counterfactual names the decision, the *trigger*
that would change it, and what you'd do instead — and it does *not*
disown a call that was right for the phase. "I'd add RLS" is wrong if
you say it as a regret; it's right if you say it as "RLS was correctly
deferred, here's the trigger that turns it on."

## The counterfactuals matrix

The chapter's anchor: each reconsiderable decision, what you'd change,
and — the column that keeps you honest — whether it's a genuine
reconsideration or a deferral that was correct for the phase.

```
  counterfactuals — decision vs what you'd change

  DECISION                  WOULD YOU CHANGE IT?       VERDICT
  ────────────────────────  ─────────────────────────  ──────────────────
  faithfulness eval         YES — wire it now, not     genuine
  left unwired              later. cuts against the    reconsideration
                            project's own thesis.       (do it sooner)

  trace flush durability    YES — make it atomic or    genuine
  (Promise.all, no retry)   retried. the trajectory     reconsideration
                            is the portfolio artifact.  (real gap)

  no timeouts / retries     YES — cheapest reliability  genuine
  on model + DB calls       win, bites even at modest   reconsideration
                            remote use.                 (pull forward)

  app_id without RLS        NO — correctly deferred.    NOT a regret
                            naming a trigger (2nd       (right for phase,
                            writer), not a regret.       trigger named)

  pgvector / local Gemma    NO — right for the goals.   NOT a regret
                            would re-make both at this  (would re-decide
                            scale.                       the same)
```

The first three are genuine. The last two are *not* — and saying so,
when asked, is itself the senior move. Walk them.

---

### Counterfactual 1 — wire the faithfulness eval sooner

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "If you were starting this over today, what would you do      │
│    differently?"                                                │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Do you have a genuine, prioritized list of reconsiderations  │
│   — or do you either claim "nothing, it's great" (no           │
│   reflection) or list everything (no judgment)? They want the  │
│   ONE you'd change first and why.                               │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "The first thing I'd change: I'd wire the faithfulness eval before I
> built any user-facing feature. The whole argument of this project is
> 'measure, don't vibe-check' — and I shipped the retrieval eval but left
> the generation side unmeasured. So I have a project whose thesis is
> rigorous measurement, with half the quality signal missing. If I were
> sequencing it again, the `RubricJudge` — grading answers against their
> retrieved chunks — would come before memory, before profile injection,
> before any feature, because an unmeasured generation path undercuts the
> reason the project exists. It's not that the features are wrong; it's
> that I built outward when I should have built the measurement spine
> first."

This is the strongest counterfactual to lead with because it's a
*prioritization* regret, not an implementation one — you'd reorder the
work, not undo it. And it cuts against your own thesis, which makes it
credible: you're not picking a safe regret.

```
  ┃ The strongest counterfactual reorders the work, it doesn't
  ┃ undo it. "I built outward before I built the measurement
  ┃ spine" is a judgment regret, not a mistake.
```

---

### Counterfactual 2 — make the trajectory capture durable

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Anything in the implementation you'd build differently?"    │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Can you find a real implementation weakness in your OWN       │
│   code, and is the weakness one that actually matters — or do  │
│   you pick a cosmetic one to look self-aware without exposing  │
│   anything real?                                                │
└─────────────────────────────────────────────────────────────────┘
```

The strong answer:

> "The trajectory capture's durability. Right now the trace sink queues
> the per-turn events and awaits them all in one `Promise.all` at flush
> time. If any one of those inserts fails, that turn's trajectory is
> partially captured and there's no retry — I get a hole. For most apps
> that'd be a minor logging gap, but here it's pointed: the trajectory IS
> the portfolio artifact, the whole 'capture everything now so fine-tuning
> is answerable later' bet. A silently-partial trajectory corrupts the
> exact dataset the project is built to produce. So I'd make the flush
> durable — either write the trace events inside the same transaction as
> the answer so they're atomic with it, or add a bounded retry on the
> queued inserts. It's the implementation gap where the failure mode
> directly undercuts the project's own goal, which is why it's the one I'd
> fix."

This works because the weakness you picked is *real and consequential*
(`src/supabase-trace-sink.ts:91`), not cosmetic — and you tie it
specifically to why it matters more here than elsewhere (the trajectory
is the product of the project). That tie is what proves you understand
your own system's stakes.

#### Weak vs strong — the implementation counterfactual

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I'd probably refactor some │ "The trace flush. It's a    │
│ of the code to be cleaner   │ Promise.all over queued      │
│ and add more tests and      │ inserts with no retry, so   │
│ better error messages."     │ one failed insert leaves a  │
│                             │ partial trajectory. That     │
│                             │ matters HERE because the     │
│                             │ trajectory is the portfolio │
│                             │ artifact — a partial one     │
│                             │ corrupts the dataset the     │
│                             │ project exists to build.     │
│                             │ I'd make it atomic or         │
│                             │ retried."                    │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Cleaner code, more tests"  │ A specific mechanism         │
│ is the universal non-answer.│ (Promise.all, no retry), a   │
│ It applies to every         │ specific consequence         │
│ codebase ever written and   │ (partial trajectory), and a │
│ reveals nothing. It's       │ specific reason it matters   │
│ self-awareness theater.     │ MORE here than elsewhere.    │
│                             │ Concrete and consequential.  │
└─────────────────────────────┴─────────────────────────────┘
```

---

### Counterfactual 3 — the decisions you would NOT change

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Would you have used a managed vector DB instead of           │
│    pgvector? Or a cloud model instead of local?"                │
│                                                                 │
│ WHAT THEY'RE TESTING                                           │
│   Will you cave and "reconsider" a decision that was actually   │
│   correct, just because they nudged? Conviction under a leading │
│   question is a signal. So is knowing the difference between a  │
│   real regret and a nudge.                                      │
└─────────────────────────────────────────────────────────────────┘
```

This is the trap, and the senior move is to *hold ground gracefully*:

> "Honestly, no — I'd make both of those calls the same way at this
> scale. pgvector was right because colocating vector and relational data
> in one Postgres gave me single-transaction consistency and no second
> system to sync, and at a few thousand chunks a managed vector DB buys
> me nothing for the network hop and the bill. Local Gemma was right for
> a privacy-first personal agent I wanted to own end-to-end. I'm happy to
> name the cost of each — pgvector's HNSW defaults degrade past ~10k
> chunks, Gemma is the reliability ceiling — but the costs were the right
> trades for the goals. I'd only revisit pgvector at a scale I don't have,
> and I'd only revisit local models if reliability became the product
> instead of privacy. So those aren't on my counterfactual list; the eval
> wiring and the trace durability are."

That's the answer that demonstrates conviction. You acknowledged the
cost of each decision (so you're not blindly defensive), but you held
that the decision was right for the phase, and you redirected to your
*real* counterfactuals. Caving to a leading question — "well, maybe
Pinecone would've been better" — when the decision was sound reads as
having no spine on your own choices.

```
  ┃ Holding ground on a right decision under a leading
  ┃ question is as much a signal as volunteering a real
  ┃ regret. Don't manufacture a counterfactual to seem humble.
```

#### The follow-up tree

```
  They nudge: "Are you sure pgvector was the right call?"
        │
        ├─► IF THEY PRESS ON SCALE
        │     → "At MY scale, yes. Past ~10k chunks I'd tune the HNSW
        │       index first, and only consider a switch if tuning ran
        │       out — but I'm nowhere near that, so it's not a regret,
        │       it's a watch item."
        │
        ├─► IF THEY PRESS ON FEATURES (hybrid search, reranking)
        │     → "Fair — pgvector is dense-only here, so it misses
        │       exact-term queries. Hybrid retrieval (BM25 + dense) is
        │       a real future add. But that's a feature gap, not a
        │       wrong-database call — I'd add hybrid IN Postgres."
        │
        └─► IF THEY ACCEPT AND MOVE ON
              → Good. You held a sound decision and named its real
                cost. Redirect to the eval-wiring counterfactual,
                which is the one you actually want on the table.
```

---

### Where you'll get pushed past your depth

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                          ║
║                                                              ║
║   The counterfactual push that can corner you: "If you were  ║
║   redesigning for the multi-device future — laptop AND       ║
║   phone sharing memory — how would you architect the sync?"  ║
║   That's the deferred two-brain problem, and it's            ║
║   distributed state reconciliation, which you haven't built. ║
║                                                              ║
║   Say:                                                       ║
║   "That's the deferred piece I'm most aware of and least     ║
║    experienced with. The shape is clear — two brains         ║
║    sharing one memory plane becomes a sync-and-merge         ║
║    problem, the same canonical-local-with-cloud-mirror       ║
║    pattern I used in another project. What I HAVEN'T solved   ║
║    is the conflict resolution: two devices writing memory    ║
║    independently, then reconciling. That's real distributed  ║
║    state, and I'd be designing it for the first time. I made ║
║    it the SECOND thing to solve deliberately, not the first  ║
║    — but I won't pretend I've designed the merge. The thing  ║
║    I CAN defend is that the VectorStore contract means each  ║
║    brain injects its own store with zero library change."     ║
║                                                              ║
║   What this signals: you know the shape and the deferral was ║
║   deliberate, you can name the unsolved hard part (conflict  ║
║   resolution) precisely, and you anchor to what DOES hold     ║
║   (the contract). You're honest about designing it for the   ║
║   first time.                                                ║
║                                                              ║
║   Do NOT say:                                                ║
║   "I'd use CRDTs and a last-write-wins clock and..." — name  ║
║   -dropping conflict-resolution primitives you haven't       ║
║   implemented. One "why a CRDT over an op-log?" and you're   ║
║   exposed.                                                   ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### What you'd change about how you present counterfactuals

The thing I'd refine in my own counterfactual delivery is leading with
them *unprompted*. The senior move is to volunteer "here are the two
things I'd change" near the end of the architecture walk, before anyone
asks — but my instinct is still to wait for the question. Pulling the
counterfactual forward, into the pitch even, would make the
self-evaluation read as a habit rather than a response. That's a
delivery change, not a content one — the counterfactuals themselves are
the right two.

---

## One-page summary — Chapter 7

**Core claim:** Volunteer what you'd reconsider before being asked — but
only what's genuinely reconsiderable. Fabricating a regret for a correct
decision reads as insecurity.

**The counterfactuals:**

- **Wire faithfulness eval sooner** — genuine; a prioritization regret
  (build the measurement spine before features), cuts against the
  project thesis.
- **Make trajectory capture durable** — genuine; `Promise.all` over
  queued inserts → partial trajectory, and the trajectory is the
  portfolio artifact.
- **pgvector / local Gemma** — NOT regrets; right for the phase, hold
  ground under the leading question, redirect to the real two.

**Pull quotes:**

```
  ┃ The strongest counterfactual reorders the work, it doesn't
  ┃ undo it.

  ┃ Holding ground on a right decision under a leading question
  ┃ is as much a signal as volunteering a real regret.
```

**The "I don't know":** Multi-device memory sync — name the shape
(canonical-local + mirror), name the unsolved part (conflict
resolution), anchor to the `VectorStore` contract that survives.
Never name-drop CRDTs you haven't built.

**What you'd change:** Lead with the counterfactuals unprompted — make
self-evaluation a habit in the delivery, not just a response.

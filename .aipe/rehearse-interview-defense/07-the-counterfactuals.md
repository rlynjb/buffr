# Chapter 7 — The Counterfactuals

"What would you do differently?" is where senior engineers separate themselves, and the move is
counterintuitive: you volunteer the answer before being asked. Naming what you'd reconsider —
unprompted, specifically, with the cost you'd pay either way — signals that you evaluate your own
decisions continuously, which is exactly the judgment a senior role is hiring for. The
anti-pattern is fabricating regret for decisions that were obviously right (don't "reconsider"
pgvector — it was correct). The skill is distinguishing the decisions that genuinely could have
gone another way from the ones that couldn't.

## The counterfactuals matrix

This is the chapter's anchor: each reconsiderable decision, what you'd change, and — critically —
whether the change is worth it. The last column is what keeps this honest.

```
  buffr — what you'd reconsider, and whether it's worth it

  ┌─ DECISION ────────────┬─ WHAT YOU'D CHANGE ──────┬─ VERDICT ────────────┐
  │ faithfulness eval     │ wire RubricJudge          │ DO IT FIRST — the    │
  │ (precision@k only)    │ against the labeled set   │ measurement gap that │
  │                       │                           │ matters most         │
  ├───────────────────────┼───────────────────────────┼──────────────────────┤
  │ emulated tool call    │ add arg-schema validation │ DO IT — closes the   │
  │ (no arg validation)   │ on the parsed JSON call   │ silent-failure hole; │
  │                       │ (aptkit-side)             │ but it's aptkit's    │
  ├───────────────────────┼───────────────────────────┼──────────────────────┤
  │ two-transaction index │ one transaction for doc + │ DO IT — cheap, same  │
  │ write (non-atomic)    │ chunks                    │ DB, removes an       │
  │                       │                           │ orphan-on-crash hole │
  ├───────────────────────┼───────────────────────────┼──────────────────────┤
  │ no streaming          │ stream tokens to the TUI  │ MAYBE — better UX,   │
  │ (await full answer)   │                           │ but loses the clean  │
  │                       │                           │ no-partial-state win │
  ├───────────────────────┼───────────────────────────┼──────────────────────┤
  │ pgvector colocated    │ — nothing —               │ DON'T — was correct; │
  │                       │                           │ faking regret here   │
  │                       │                           │ would be a tell      │
  ├───────────────────────┼───────────────────────────┼──────────────────────┤
  │ build aptkit          │ — nothing, for THIS goal —│ DON'T — right for a  │
  │                       │                           │ portfolio/learning   │
  │                       │                           │ project; buy on a    │
  │                       │                           │ team                 │
  └───────────────────────┴───────────────────────────┴──────────────────────┘
```

The bottom two rows are as important as the top three. Knowing which decisions you would NOT
change — and being able to say why faking a regret there would be dishonest — is part of the
signal.

## "What would you do differently if you started today?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "If you were starting this over, what would you do             │
│    differently?"                                                │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you evaluate your own work critically without trashing    │
│   it? They want a SPECIFIC reconsideration with a real cost,    │
│   not "I'd write more tests" (generic) and not "nothing, it     │
│   was perfect" (no self-awareness). The best answer is          │
│   volunteered, ordered by leverage.                            │
└─────────────────────────────────────────────────────────────────┘
```

> "Three things, in order of leverage. First and most important: I'd wire the faithfulness eval
> before I added a single new feature. Right now I measure retrieval — precision@k and recall@k —
> but not whether the answer is actually grounded in what was retrieved. aptkit has a `RubricJudge`
> for exactly this and it's unwired in buffr. That's the gap I'd close first, because everything
> else I'd build is unmeasurable for faithfulness until it's in.
>
> Second, I'd add argument-schema validation to the emulated tool-call path. Today a wrong key from
> the model produces an empty query and silent garbage retrieval, with no error. That's the worst
> failure in the system and it's invisible. The fix lives in aptkit, but I'd prioritize it.
>
> Third, smaller: the index write spans two transactions, so a crash between the document write and
> the chunk write orphans a document. Both writes hit the same Postgres — I'd wrap them in one
> transaction. Cheap fix, removes a real consistency hole.
>
> What I would *not* change: pgvector colocated in Postgres, and building aptkit. Those were the
> right calls for this project, and I'd be making up a regret if I pretended otherwise."

That last paragraph is the senior move. Volunteering the boundary of your regret — "these I'd keep"
— proves the reconsiderations above are reasoned, not reflexive self-flagellation.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd probably write     │ "I'd wire the           │
│ more tests and clean    │ faithfulness eval        │
│ up the code a bit.      │ first — I measure        │
│ Maybe use a different   │ retrieval but not        │
│ database."              │ grounding. Then add      │
│                         │ arg-schema validation    │
│                         │ to the tool-call path.   │
│                         │ Then make the index      │
│                         │ write atomic. I would    │
│                         │ NOT change pgvector or   │
│                         │ building aptkit — those  │
│                         │ were right."             │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "More tests" is the     │ Specific, ordered by    │
│ generic non-answer.     │ leverage, each with a   │
│ "Maybe a different      │ real cost, AND it       │
│ database" with no       │ names what it would     │
│ reason invents a regret │ NOT change — proving    │
│ for a decision that was │ the regrets are         │
│ correct. Both signal no │ reasoned, not           │
│ real reflection.        │ reflexive.              │
└─────────────────────────┴─────────────────────────┘
```

> ┃ The senior-engineer move is to volunteer what you'd
> ┃ reconsider before being asked — and to name what you'd keep.

```
"What would you do differently?"
      │
      ▼
You give the three-reconsiderations-and-two-keeps answer.
      │
      ├─► IF THEY ASK "why didn't you do the faithfulness eval already?"
      │     "Sequencing. Retrieval eval is unambiguous — did the right
      │      chunk come back? Faithfulness needs a judge I have to
      │      validate against human labels first. I built the
      │      measurable half and deferred the half that needs more
      │      scaffolding. Reasonable order, but it left a gap."
      │
      ├─► IF THEY PROBE A 'KEEP' ("sure pgvector was right?")
      │     "At my scale, yes. The day the vector count dwarfs the
      │      relational data, I'd revisit. That day hasn't come, so
      │      changing it now would be solving a problem I don't have."
      │
      └─► IF THEY ASK "what about the bigger architecture?"
            "The deferred two-brain split — laptop + phone. I'd design
             the phone brain's auth and RLS boundary up front rather
             than retrofit it. The app_id column is already shaped for
             it; I just haven't built the enforcement." (ch 8 / scale)
```

## "Would you change the architecture itself?"

The deeper counterfactual is structural, and it ties to the deferred roadmap.

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                        │
│   "Is there a structural decision you'd revisit, not just a     │
│    feature?"                                                    │
│                                                                 │
│ WHAT THEY'RE TESTING                                            │
│   Can you reconsider at the architecture level, not just the    │
│   bug level? And do you know which structural choices were      │
│   deferred deliberately versus made wrong?                     │
└─────────────────────────────────────────────────────────────────┘
```

> "The honest one is the security boundary for the deferred phone brain. buffr ships with `app_id`
> on every table — it *looks* like multi-tenant isolation, but it's shape-only: the value comes from
> an environment variable, not from an authenticated identity, and there's no row-level security
> enforcing it. At single-operator scale that's correct — the OS user account is the auth boundary,
> there's no second tenant to isolate. But the moment the phone brain appears as a second device,
> that column has to become a real security boundary: `app_id` and `user_id` derived from a token,
> enforced by RLS.
>
> What I'd do differently is design that enforcement up front instead of leaving it as shape. Not
> *build* it early — that'd be premature for a single-device tool — but at least decide the auth
> model before the second device exists, so I'm not retrofitting RLS onto a schema that grew
> assuming one tenant. The column being there already is the right instinct; the enforcement plan
> being absent is the gap."

This is a strong structural counterfactual because it's *not* a regret about something broken —
it's a deferred decision you'd sequence differently. That distinction is itself the senior signal.

## When they push past your depth

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                           ║
║   They push the RLS thread: "Walk me through the RLS      ║
║   policies you'd write. How do you stop a tenant from     ║
║   forging the app_id? How does the policy interact with   ║
║   the connection pool and the role the app connects as?"  ║
║                                                           ║
║   You understand RLS conceptually and the app_id/user_id  ║
║   shape. You have NOT written and operated RLS policies    ║
║   with pooled connections and role separation in           ║
║   production. This is past your built experience.          ║
║                                                           ║
║   Say:                                                    ║
║   "I know the shape: RLS policies keyed on app_id and     ║
║    user_id, with the tenant identity set from a verified  ║
║    token — not a value the client supplies — so the       ║
║    database enforces the filter instead of trusting the   ║
║    app to ask only for its own rows. The interaction with ║
║    a pool and the connecting role is exactly the part I'd  ║
║    have to get right carefully and haven't operated —      ║
║    setting the tenant context per-checkout so a pooled    ║
║    connection doesn't leak one tenant's context into the  ║
║    next request. I understand WHY that's the hard part; I  ║
║    haven't shipped it, so I'd want to build it against     ║
║    real tests rather than claim I've run it."             ║
║                                                           ║
║   What this signals: you understand the trust model and    ║
║   the specific hard part (per-checkout context on a pool), ║
║   and you draw the line at production operation honestly.  ║
║                                                           ║
║   Do NOT say:                                             ║
║   "RLS just handles it automatically once you turn it on." ║
║   — that ignores the pool-context leak the question is     ║
║   specifically probing and signals you've only read about  ║
║   RLS, never wired it.                                     ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change about how you reconsider

The meta-reconsideration: early on you'd have answered "what would you do differently?" by listing
everything imperfect, which reads as low confidence. The stronger discipline you'd apply now is to
*rank by leverage and name the keeps* — three real reconsiderations ordered by impact, plus the
decisions you'd defend unchanged. A flat list of regrets undersells the work; a ranked list with
explicit keeps shows judgment.

## One-page summary

**Core claim:** Volunteer your reconsiderations before being asked, ranked by leverage, each with
a real cost — and name the decisions you would NOT change, because faking regret for a correct
decision is a tell. The skill is distinguishing genuinely-reconsiderable choices from obviously-
right ones.

**Questions covered:**
- *"What would you do differently?"* → (1) wire the faithfulness eval first, (2) add arg-schema
  validation to the tool-call path, (3) make the index write atomic; would NOT change pgvector or
  building aptkit.
- *"Why not done already?"* → sequencing: built the measurable half (retrieval), deferred the half
  needing a validated judge (faithfulness).
- *"A structural decision you'd revisit?"* → design the phone-brain auth/RLS boundary up front
  rather than retrofit onto a shape-only `app_id`.
- *"Walk me through the RLS policies?"* → name the trust model and the per-checkout-context-on-a-
  pool hard part; admit you haven't operated it.

**Pull quotes:**
- "The senior-engineer move is to volunteer what you'd reconsider before being asked — and to name
  what you'd keep."
- "Faking regret for a decision that was correct is a tell. Naming the keeps is part of the signal."

**What you'd change:** Rank reconsiderations by leverage and name the keeps explicitly — a flat
list of regrets undersells the work; a ranked list with defended keeps shows judgment.

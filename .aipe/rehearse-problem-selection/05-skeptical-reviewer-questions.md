# 05 — The Skeptical Reviewer's Questions

The review room. Everything in `01`–`04` was you presenting; this file is the skeptic pushing
back. The coach job here is blunt: for each objection, the *weak* answer that loses the room,
the *strong* answer in your voice that holds, and the one-line anchor you land it on. Hold the
anchors, not the prose — the anchor is what survives the adrenaline.

## Zoom out — the seven pushbacks, ranked by danger

Not all objections are equal. Some are fatal if fumbled (the "one user" and "off-the-shelf"
ones); some are easy points if you're ready. Here they are, ordered by how much a bad answer
costs you.

```
  The skeptic's attack order — most dangerous first

  ┌─ FATAL IF FUMBLED ────────────────────────────────────────────────┐
  │  Q1 "one user proves nothing"        → reframe: proof not market   │
  │  Q2 "why not just use Hermes?"        → turnkey hides the signal    │
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ COSTLY IF VAGUE ─────────────▼───────────────────────────────────┐
  │  Q3 "this is just RAG"                → the weak-model robustness   │
  │  Q4 "no market = no problem"          → cost of NOT solving (career)│
  │  Q5 "why defer the phone/RLS/HTTP?"   → one-way doors, named returns│
  └───────────────────────────────┬───────────────────────────────────┘
  ┌─ EASY POINTS IF READY ────────▼───────────────────────────────────┐
  │  Q6 "where's the eval rigor?"         → 3 metrics, hard gate, loop  │
  │  Q7 "what if you're wrong about it?"  → the I-don't-know recovery   │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Q1 — "One user proves nothing. This is a toy."

The most dangerous question, because the lazy answer (defensiveness) confirms the skeptic's
prior.

```
  Q1 — the reframe that wins it

  WEAK:   "well, it could scale to more users later…"
          (concedes the frame — now you're defending a toy)

  STRONG: flip market → proof
          n=1 is empty for retention/churn — but precision@k,
          faithfulness, JSON-validity are SYSTEM properties, honest
          at any scale. one user = zero market noise = clean test bench.
```

**Strong answer, your voice:**
> "It proves the thing I'm trying to prove. I'm not measuring a user base — retention and
> churn are statistically empty at n=1, and I won't quote them. I'm measuring properties of
> the system: precision@k, faithfulness, JSON-validity. Those are fully honest with one user,
> and one user means zero market noise in the signal. It's a proof problem, not a market
> problem, and one user is the cleanest possible bench for it. If you want to probe whether I
> can do the engineering, n=1 is exactly the right scope."

**Anchor:** *"It's a proof problem, not a market problem — and the metrics are honest at n=1."*

---

## Q2 — "Why not just use Hermes? It already does this."

The build-vs-buy challenge. The strong answer is *already having evaluated it* — you didn't
build out of ignorance.

```
  Q2 — the asymmetry, stated flat

  WEAK:   "I wanted to build my own version" (sounds like NIH syndrome)

  STRONG: "I evaluated Hermes directly and chose to build."
          Hermes solves the PRODUCT problem and hides the PROOF problem.
          the provider contract, the RAG pipeline, the evals — the parts
          you'd probe — are exactly what it abstracts away.
          (and I'm not naive: I reuse aptkit's loop + pgvector. build the
           glue and judgment; buy the substrate.)
```

**Strong answer, your voice:**
> "I evaluated Hermes directly — it's the obvious buy. I chose to build because a turnkey tool
> hides exactly the parts that signal skill. Hermes is a multi-agent platform on Nous's
> fine-tuned models; using it gives me a working agent and zero proof I can build one. The
> provider contract, the RAG pipeline, the eval numbers — what you'd actually probe — are the
> parts it abstracts. But I'm not reinventing everything: I reuse aptkit's agent loop and
> pgvector's search because rebuilding those costs scope and hides nothing. I build the glue
> and the judgment layer. That's where the signal lives."

**Anchor:** *"A turnkey tool hides exactly the parts that signal skill."*

---

## Q3 — "This is just RAG. Everyone's built a RAG demo."

The "not impressive" jab. The answer is the *weak local model* — the constraint that turned a
demo into engineering.

```
  Q3 — where the engineering actually got hard

  WEAK:   "but mine has memory and trajectory capture too!"
          (feature-listing — the skeptic shrugs)

  STRONG: the hard part wasn't RAG — it was making a WEAK local model
          behave. stock Gemma 2, not a frontier API:
          • messy JSON → structured-generation to tame it
          • passed top_k:1, starving multi-part Qs → a minTopK floor
          • hallucinated a filter key → guard that ignores absent keys
          a hosted frontier model HIDES all three. the local constraint
          surfaced them — and surfacing + fixing them is the signal.
```

**Strong answer, your voice:**
> "The RAG shape is the easy part — I'll grant that. What's not easy, and what I'd point you
> at, is making a *weak local model* behave. I'm running stock Gemma 2 on my own machine, not
> a frontier API. Gemma emitted messy JSON, so I leaned on structured-generation to tame it.
> It passed top_k:1 and starved multi-part questions, so I wired a minTopK floor. It
> hallucinated a filter key that silently zeroed out retrieval, so I added a guard that
> ignores keys absent from the metadata. A hosted frontier model hides all three of those.
> The local constraint surfaced them, and finding and fixing them is exactly the engineering."

**Anchor:** *"The hard part wasn't RAG — it was making a weak local model behave."*

---

## Q4 — "No market means no real problem. Who's this for?"

The product-thinking challenge. Answer with the *cost of not solving* — the career problem,
named without flinching.

```
  Q4 — name the real beneficiary and the real cost

  WEAK:   "it's for me, personally" (sounds like a hobby)

  STRONG: two problems, one coat. product pain is real but secondary.
          the load-bearing problem is a CAREER one: 7 yrs frontend reads
          as a frontend engineer until there's proof of the AI-eng
          combination. cost of NOT solving = the pivot stalls. the
          beneficiary is the portfolio case, and that's a real problem.
```

**Strong answer, your voice:**
> "It's for one person, and I won't pretend otherwise — but that's the right answer, not a
> dodge. There are two problems here. The product pain is real: my context is scattered across
> the apps I've shipped and nothing reasons across them. But the load-bearing problem is a
> career one — seven years of frontend reads as a frontend engineer until there's a proof
> artifact for the AI-engineering combination. The cost of not solving it is concrete: the
> pivot stalls, and 'pivoting to AI' stays a claim with nothing under it. The beneficiary is
> the portfolio case. That's a real problem with a real cost — it just isn't a market."

**Anchor:** *"The cost of not solving it is the pivot stalls — that's a real problem, not a market."*

---

## Q5 — "Deferring the phone, RLS, the HTTP API — isn't that just unfinished?"

The "you ran out of time" trap. Answer: every cut is a *decision* with a *named return path*,
and the phone specifically is a one-way-door dodge.

```
  Q5 — cuts are decisions, not gaps

  WEAK:   "I'd do those next if I had time" (concedes it's unfinished)

  STRONG: each cut is documented with a reason and a no-rework return:
    phone   → one-way door (sync forces irreversible choices) — dodged
              on purpose until the single brain is proven
    RLS     → app_id column shipped NOW (cheap), policy deferred (cheap
              later) — the forward-compat line drawn exactly right
    HTTP    → YAGNI for one client; wraps the SAME SQL when app #2 lands
    all reachable on the same schema + VectorStore port — additive, not rework.
```

**Strong answer, your voice:**
> "None of those are unfinished — they're cuts, each with a reason and a return path that costs
> no rework. The phone is the clearest: laptop-phone sync forces irreversible choices —
> conflict resolution, sync protocol — and I refuse to lock those in before the single brain
> is even proven good. So I deferred it on purpose. RLS: I shipped the app_id column now
> because adding a column to a live corpus later is a migration, but I deferred the policy
> because that's a few lines whenever app #2 arrives. The HTTP API is YAGNI for one client and
> wraps the same SQL later. Every one of those is named in a design spec and reachable on the
> same schema. That's scope discipline, not an unfinished list."

**Anchor:** *"Every cut is a decision with a named, no-rework return path — including dodging the phone's one-way door."*

---

## Q6 — "Where's the eval rigor? Anyone can claim their agent works."

The easy points — if you're ready. Lead with the three distinct metrics and the hard gate.

```
  Q6 — three metrics, one hard gate, a decision loop

  WEAK:   "it works pretty well in my testing" (a vibe, not a number)

  STRONG: precision@k / recall@k (retrieval) · faithfulness via rubric
          judge (synthesis) · JSON-validity (the weak model). three
          metrics localize the failure. hard gate: precision@5 ≥ 0.8
          before integration. the Phase-4 write-up — numbers + failure
          breakdown + chosen next action — IS the portfolio artifact.
```

**Strong answer, your voice:**
> "Three metrics, and they don't overlap. Precision and recall@k on a labeled set for
> retrieval, faithfulness scored by a rubric judge for synthesis, JSON-validity rate for the
> weak model's tool calls. When quality drops, one number can't tell me why — these three
> localize it to retrieval, synthesis, or the model. There's a hard gate: precision@5 clears
> 0.8 before I build the agent on top. And the output is a written decision — the numbers, the
> failure categories, the next action — made from the evidence. That write-up is the artifact
> that proves AI engineering versus playing with an LLM."

**Anchor:** *"Three non-overlapping metrics, a precision@5 ≥ 0.8 gate, and a decision made from the numbers."*

---

## Q7 — "What if you're wrong, and the evals come back bad?"

The pressure question — and the place to model the "I don't know" recovery. The strong move is
*not* to defend; it's to show the failure has a planned, evidence-driven response.

```
  Q7 — being wrong is a BRANCH in the design, not a surprise

  WEAK:   "I'm confident it'll be fine" (the skeptic now wants you wrong)

  STRONG: "then the design already tells me what to do." bad evals aren't
          a failure of the project — they're an INPUT to the Phase-4 gate:
          50–80% retrieval-bound → fix retrieval; model-bound → escalate /
          maybe fine-tune; <50% → architecture problem, rethink it.
          the project's deliverable is the DECISION, so a bad number is
          still a successful outcome of the experiment.
```

**Strong answer, your voice:**
> "Then the design already tells me what to do — that's the point of measuring. Bad evals
> aren't a failure of the project; they're the input the whole thing is built to consume. If
> precision lands 50 to 80% and it's retrieval-bound, I fix retrieval. Model-bound, I escalate
> the fallback chain and consider fine-tuning only if the failure's narrow. Below 50%, it's an
> architecture problem and I rethink the design instead of papering over it with training. The
> deliverable here is the *decision made from evidence* — so a number coming back bad is still
> a successful run of the experiment. The honest version of this project survives being
> wrong."

**Anchor:** *"Bad evals are an input to the decision, not a failure of the project — the deliverable is the decision."*

---

## Primary diagram — the defense on one page

Every objection, its anchor, the one line that holds it.

```
  THE DEFENSE — objection → anchor, one frame

  Q1 "one user"        ──► proof problem, not market — metrics honest at n=1
  Q2 "why not Hermes"  ──► a turnkey tool hides exactly the parts that signal skill
  Q3 "just RAG"        ──► the hard part was making a WEAK local model behave
  Q4 "no market"       ──► cost of not solving = the pivot stalls (a real problem)
  Q5 "unfinished"      ──► every cut is a decision with a no-rework return path
  Q6 "eval rigor"      ──► 3 non-overlapping metrics, precision@5 ≥ 0.8 gate
  Q7 "what if wrong"   ──► bad evals are an INPUT to the decision, not a failure
```

## The principle

Under pressure, you don't win by having more facts — you win by having already *named the
weakness yourself* before the skeptic does. Every hard question here (one user, off-the-shelf,
just RAG, no market) is one you raised and answered in `01`–`04`. The skeptic can't corner you
on a hole you already walked them through. The strongest defense of a problem selection is a
brief honest enough that the objections are already inside it.

## See also

- `01-problem-brief.md` — why this / why now / why her / cost of not solving
- `02-scope-cuts-and-non-goals.md` — the cuts behind Q5
- `03-options-and-opportunity-cost.md` — the build-vs-buy behind Q2
- `04-success-metrics-and-feedback-loop.md` — the metrics and gate behind Q1, Q6, Q7
- `.aipe/rehearse-interview-defense` — the codebase-defense companion to this problem defense

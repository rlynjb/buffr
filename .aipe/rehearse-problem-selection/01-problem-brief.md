# 01 — Problem Brief

**The load-bearing file.** Everything else in this bundle is a cut of this one. If you
rehearse one file before a senior interview or a promo conversation, rehearse this. By the
end you should be able to justify the problem *before* you've described the solution — and
hold every follow-up.

## Zoom out — where the problem sits

Before the pain, see the whole shape: a career pivot, a portfolio, and one project that
has to carry the weight of proving a combination is real.

```
  Zoom out — the problem lives at the pivot point, not in the product

  ┌─ Career layer (the actual problem) ──────────────────────────────────┐
  │  7yr frontend engineer  →  ★ PIVOT POINT ★  →  AI engineer           │ ← we are here
  │  Vue/React, FedEx/Amazon/CoreWeave, ~$700K savings                    │
  │  the pivot is unproven until ONE artifact proves the combination      │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ the artifact must EXPOSE engineering, not hide it
  ┌─ Product layer (the vehicle) ─▼──────────────────────────────────────┐
  │  self-hosted personal agent — centralizes the AGENT LAYER, knows her  │
  │  over time (Hermes-shaped)                                            │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ built end-to-end, measured
  ┌─ Engineering layer (the proof) ▼─────────────────────────────────────┐
  │  provider contract · RAG from scratch · evals with numbers           │
  │  the parts "a turnkey tool hides" (agent-layer-plan.md:25)           │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pain is not "I lack a personal assistant." Plenty of those exist to buy. The
pain is **"my pivot from frontend to AI engineering is unproven, and the thing that would
prove it has to be a system whose hard parts I built myself."** The product is the vehicle.
The career proof is the cargo. Confuse the two and you'll defend the wrong problem in the
room.

## Structure pass

**Layers:** career (the real problem) → product (the vehicle) → engineering (the proof).
The justification has to be coherent across all three at once.

**Axis — *who is this evidence for?*** Trace it down the layers and watch it flip:

```
  one axis — "who is the audience for the evidence?" — traced down

  ┌─ career layer ────────────────┐   audience = a hiring manager / promo committee
  │ proves the pivot is real      │   evidence = a shipped, measured artifact
  └───────────────┬───────────────┘
  ┌─ product layer ▼──────────────┐   audience = future-her (the one user)
  │ an agent that knows her       │   evidence = it works on her own data
  └───────────────┬───────────────┘
  ┌─ engineering layer ▼──────────┐   audience = a senior engineer reviewing the code
  │ the parts Hermes hides        │   evidence = numbers (precision@k, faithfulness)
  └───────────────────────────────┘
```

The axis-answer flips at every layer — and *that contrast is the whole brief*. The single
user is the right audience at the product layer; the hiring manager is the audience at the
career layer; the senior engineer is the audience at the engineering layer. The brief is
strong precisely because it doesn't pretend one audience is all three.

**Seam:** the load-bearing boundary is the one between **"buy a tool that works"** and
**"build the parts that signal skill."** That's where the problem's value lives — the
build-vs-buy decision (deep-walked in `03-options-and-opportunity-cost.md`). The moment you
choose *buy*, the career-layer evidence evaporates, even though the product-layer pain is
satisfied. The seam is load-bearing because the axis-answer "who is the evidence for?"
flips across it: buying satisfies future-her, building satisfies the hiring manager.

## The brief — answered in order

### 1. User or operational problem — who experiences what pain

**The user is Rein.** One user, deliberately. The pain has two faces and you must name
both:

- **Product-face pain:** her data lives scattered across her apps (`buffr`, `contrl`,
  `blooming_insights`, …), and no single agent reasons over it or "knows her over time."
  Each app has its own schema; nothing composes them into one model-of-her.
- **Career-face pain (the real one):** she's mid-pivot from frontend to AI engineering,
  and the pivot is **unproven**. A résumé that says "7 years Vue/React + now AI" is a
  claim with no artifact behind it. The portfolio is *"the case for that combination"*
  (`me.md`, "WHO YOU ARE"). Without one end-to-end, measured AI-engineering build, the
  combination is asserted, not demonstrated.

Lead with the career-face pain in any interview. The product is real, but the product is
the *vehicle* — the engineering judgment it forces you to exercise is the deliverable.

### 2. Evidence and current cost — what's documented vs inferred

**Distinguish hard evidence from inference. Say which is which — a brief that blurs them
loses the room on the first follow-up.**

```
  evidence ledger — documented vs inferred

  ┌─ DOCUMENTED (cite these) ────────────────────────────────────────────┐
  │ • "a turnkey tool hides exactly the parts that signal engineering    │
  │    skill"                              agent-layer-plan.md:25         │
  │ • the deliverable is "one good agent with measured eval numbers —    │
  │    not a platform"                     agent-layer-plan.md:6          │
  │ • build-vs-buy evaluated against Hermes DIRECTLY, chose build        │
  │                                        agent-layer-plan.md:13-35      │
  │ • centralize the AGENT LAYER, not the DATA  agent-layer-plan.md:83   │
  │ • Phase-4 one-pager is THE portfolio artifact  agent-layer-plan.md:33│
  │ • the build was actually shipped to v1b (laptop brain, persistent,   │
  │    live against reindb 2026-06-19)  ...graduation-design.md:199-217  │
  │ • 7yr frontend, FedEx/Amazon/CoreWeave, ~$700K savings  me.md        │
  │ • adjacent pieces already shipped: AdvntrCue RAG, dryrun/contrl      │
  │    on-device AI, aipe  me.md (system-design portfolio)               │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ INFERRED (label it when you say it) ────────────────────────────────┐
  │ • that this artifact will MOVE a specific hiring decision — likely,  │
  │    but not yet proven; the eval numbers don't exist yet              │
  │ • that "knows her over time" delivers daily product value — the      │
  │    one user hasn't lived with it long enough to confirm             │
  └───────────────────────────────────────────────────────────────────────┘
```

**The current cost** of the problem unsolved: the pivot stays a claim. Every month the
combination is unproven is a month of interviews where "I'm moving into AI engineering"
has no artifact to anchor it — and a frontend engineer *asserting* an AI pivot reads very
differently from one who can open a repo and walk a measured RAG agent end-to-end.

### 3. Why now — what changed, what compounds

```
  why now — the timing argument as a layered diagram

  ┌─ what changed ───────────────────────────────────────────────────────┐
  │  she is AT the pivot point (me.md: "this is where you are"), working  │
  │  IK's frontend program in parallel with building AI-native projects   │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ and the adjacent pieces already exist
  ┌─ what's newly possible ───────▼──────────────────────────────────────┐
  │  AdvntrCue proved RAG · dryrun/contrl proved on-device AI · aipe      │
  │  proved meta-tooling — the parts are SHIPPED, ready to compose        │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ and the cost compounds
  ┌─ what compounds if deferred ──▼──────────────────────────────────────┐
  │  every month unproven = interviews with no artifact + the adjacent    │
  │  skills going stale instead of composing into one case                │
  └───────────────────────────────────────────────────────────────────────┘
```

"Why now" is not "the technology is new." It's **"the pieces are already shipped and the
pivot needs proof today, not eventually."** The build composes work she's *already done*
(`me.md`'s five system shapes) into the one artifact the pivot lacks. Waiting doesn't make
the parts easier to assemble — it lets them age separately while the claim stays unbacked.

### 4. Beneficiaries and exclusions — who's in, who's deliberately out

```
  who benefits · who is intentionally outside scope

  ┌─ IN scope (beneficiaries) ───────────┐  ┌─ OUT of scope (excluded) ──────────┐
  │ • Rein — the one user AND the one     │  │ • other users / a user base        │
  │   engineer whose portfolio this is    │  │   → "not a platform" (plan:6)      │
  │ • future hiring managers / reviewers  │  │ • her other apps as consumers YET  │
  │   (the evidence audience)             │  │   → HTTP API deferred (...graduation│
  │                                       │  │     -design.md:27, YAGNI till app#2)│
  │                                       │  │ • the phone brain / two-brain body  │
  │                                       │  │   → deferred one-way door (07-      │
  │                                       │  │     deferred-body.md)              │
  └───────────────────────────────────────┘  └─────────────────────────────────────┘
```

The exclusions are the senior move. Naming who you *won't* serve — no user base, no
multi-app HTTP consumers yet, no phone — is what separates a scoped portfolio problem from
a wishlist. Each exclusion is documented as a deliberate cut, not an oversight (see
`02-scope-cuts-and-non-goals.md`).

### 5. Constraints — visible from the repo and the documented decisions

```
  constraints — what bounds the problem before solution design

  ┌─ technical ──────────────────────────────────────────────────────────┐
  │  • build-locally-first on an M-series Mac (Ollama gemma2:9b +         │
  │     nomic-embed-text, both local)  context.md / agent-layer-plan.md   │
  │  • embedding dimension is a ONE-WAY DOOR for data (768, locked)       │
  │     agent-layer-plan.md:115                                           │
  │  • Gemma has no native tool-calling — the riskiest piece              │
  │     ...aptkit-packages-design.md:136                                  │
  ├─ product ────────────────────────────────────────────────────────────┤
  │  • one good agent end-to-end, measured — NOT a platform  plan:6       │
  │  • centralize the agent layer, not the data — apps keep schemas plan:83│
  ├─ time / resourcing ──────────────────────────────────────────────────┤
  │  • one developer; ~4-week phase plan, each phase ends in a            │
  │     hand-testable artifact  agent-layer-plan.md:89                    │
  ├─ migration / reversibility ──────────────────────────────────────────┤
  │  • defer the two-brain laptop+phone body to dodge one-way doors       │
  │     07-deferred-body.md                                               │
  └───────────────────────────────────────────────────────────────────────┘
```

These constraints aren't excuses — they're the frame that makes the scope honest. "One
developer, four weeks, locally on a Mac, one user" is *why* the smallest-useful-slice
discipline in `02` is the right call, not a compromise.

## The "why her" close — the strongest single answer

When a reviewer asks *"why are you the person to build this?"*, this is the answer that
lands. It's not ambition — it's **composition of shipped work.**

```
  why her — the portfolio composes, it doesn't start over

  ┌─ already shipped (me.md system-design portfolio) ────────────────────┐
  │  AdvntrCue   → classic RAG, pgvector + GPT-4 (the retrieval layer)    │
  │  dryrun      → on-device AI, Gemini Nano + fallback (local-first)     │
  │  contrl      → real-time on-device ML pipeline (the AI substrate)     │
  │  aipe        → markdown-as-source, prompt-as-code (meta-tooling)      │
  │  +7yr frontend, Vue/React, FedEx/Amazon/CoreWeave, ~$700K savings     │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ buffr COMPOSES these into one case
  ┌─ what buffr adds that none had alone ────────────────────────────────┐
  │  • a provider contract she wrote (Gemma ModelProvider)               │
  │  • RAG rebuilt from scratch (NOT ported from AdvntrCue's OpenAI weld) │
  │  • evals with NUMBERS — the separator between "played with an LLM"    │
  │     and "does AI engineering"  agent-layer-plan.md:30                 │
  └───────────────────────────────────────────────────────────────────────┘
```

Say it like this: *"I'm not pivoting from zero. I shipped the RAG, the on-device AI, and
the meta-tooling separately. buffr is the artifact that composes them into one measured
system — and it forces me to build the parts a turnkey tool would hide: a provider
contract, retrieval from scratch, and evals with real numbers."* That's the close. It's
documented, it's specific, and it doesn't overclaim.

## The principle

A problem is worth investing in when the **cost of not solving it compounds** and the
**person solving it is uniquely positioned to**. Here both hold and both are documented:
the pivot stays unproven every month it lacks an artifact (compounding cost), and the
adjacent pieces are already shipped and waiting to compose (unique position). The product
is real, but the problem you're actually justifying is the *career proof* — and the
strongest version of that case never invents a market, a user base, or a number. It says:
*one user, measured, composing work I've already shipped, exposing the engineering a tool
would hide.*

## Interview defense

**Q: Isn't a personal agent for one user just a toy?**
No — it's a *proof problem, not a market problem*. The deliverable is "one good agent with
measured eval numbers — not a platform" (`agent-layer-plan.md:6`). One user is the correct
scope for proving I can build the engineering under a real AI product. More users would be
scope I'd have to defend without evidence — the opposite of a measured portfolio piece.
Anchor: `agent-layer-plan.md:6`.

```
  one user = right scope for the claim "I can build + measure this"
  more users = scope to defend with evidence I don't have yet
```

**Q: Why does this prove anything a take-home or a Leetcode round wouldn't?**
Because it shows the parts a turnkey tool hides — a provider contract I wrote, RAG rebuilt
from scratch, evals with numbers — end to end, on my own data, shipped to a persistent v1b.
That's "does AI engineering," not "played with an LLM" (`agent-layer-plan.md:30`).
Anchor: `agent-layer-plan.md:25,30`.

**Q: Why you, specifically?**
Because I've already shipped the adjacent pieces separately — RAG (AdvntrCue), on-device
AI (dryrun/contrl), meta-tooling (aipe) — and buffr is the one artifact that composes them
into a measured system. I'm not starting over; I'm composing 7 years of frontend plus four
shipped AI system shapes into the case for the combination. Anchor: `me.md` system-design
portfolio.

## See also

- `02-scope-cuts-and-non-goals.md` — the smallest useful slice and what's deliberately cut.
- `03-options-and-opportunity-cost.md` — build vs buy, decided against Hermes directly.
- `agent-layer-plan.md` — the parent thesis every claim here cites.
- `.aipe/study-system-design/07-deferred-body.md` — the one-way-door reasoning behind the cuts.

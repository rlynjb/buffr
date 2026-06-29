# 00 — Overview: Problem Selection for the Centralized Agent Layer

This is the human layer *before* the design doc. Not "how did I build buffr" — that's
`study-system-design` and the design specs. This is the harder question a staff reviewer
asks first and an interviewer asks before they care about your HNSW params: **why does this
problem deserve the investment at all, and why are you the person to spend it?**

You answer the *how* fluently already. This bundle drills the *why* — and it drills it in
the order a skeptic actually pushes: justify the problem, *then* defend the build.

## The whole brief, one frame

```
  Problem-selection brief — the order a reviewer interrogates it

  ┌─ 01 PROBLEM BRIEF ────────────────────────────────────────────────┐
  │  why this · why now · why her · cost of NOT solving                │
  │  who experiences the pain · what the repo already proves           │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  "okay, the problem is real. now —"
                                  ▼
  ┌─ 02 SCOPE, CUTS & NON-GOALS ──────────────────────────────────────┐
  │  the smallest slice that validates the premise                    │
  │  what you deliberately did NOT build (phone, RLS, HTTP, fine-tune) │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  "why build it — Hermes exists?"
                                  ▼
  ┌─ 03 OPTIONS & OPPORTUNITY COST ───────────────────────────────────┐
  │  build vs buy (Hermes) vs do-nothing · centralize layer not data  │
  │  one agent not a platform · the cost of each road not taken       │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  "how will you know it worked?"
                                  ▼
  ┌─ 04 SUCCESS METRICS & FEEDBACK LOOP ──────────────────────────────┐
  │  precision@k · faithfulness · JSON validity · the Phase-4 decision │
  │  one user is a PROOF problem, not a market problem                 │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  "here's where I'd push back —"
                                  ▼
  ┌─ 05 SKEPTICAL REVIEWER QUESTIONS ─────────────────────────────────┐
  │  the review-room objections + the answers that hold               │
  │  "one user" · "off-the-shelf" · "no market" · "just RAG"          │
  └───────────────────────────────────────────────────────────────────┘
```

## The thesis in one paragraph

A self-hosted personal agent — one that centralizes the *reasoning layer* across your apps
and "knows you over time" — is a **proof problem, not a market problem.** The pain is real
and documented: your data and your context are scattered across `buffr`,
`blooming_insights`, `contrl`, and every app keeps its own schema, so nothing can answer a
question that spans them. The off-the-shelf option (Hermes Agent) *solves that for you* — and
that is precisely why building it yourself is the right call here. The deliverable is not a
product with users; it's the **portfolio case** that you can do the engineering a turnkey
tool hides: a provider contract for a weak local model, a RAG pipeline you actually built,
trajectory capture from day one, and a ship/iterate/fine-tune decision made *from* measured
evals. One user isn't a weakness to apologize for — it's the structural strength that lets you
prove the engineering end-to-end with zero market noise in the signal.

## Grounding discipline

Every claim in this bundle is anchored to a documented decision — the `agent-layer-plan.md`
vision, the two design specs under `docs/superpowers/specs/`, and the shipped code the study
guides audit. Where something is inference rather than a recorded decision, it's labeled.
**Nothing here invents users, metrics, market evidence, or organizational constraints** —
because the honest version of this story is stronger than any invented one. The single most
important move in this whole bundle is refusing to fake a market and instead reframing "one
user" as exactly the right scope for a proof.

## How to rehearse this

Read it in order — the files mirror the order a reviewer attacks. For each file, the coach
voice gives you the **strong first-person answer in your voice** (the thing to actually say),
then the diagram you'd sketch while saying it, then the one-line anchor to land it. Don't
memorize prose; hold the diagram and the anchor. The picture is what survives the pressure.

## See also

- `01-problem-brief.md` — why this / why now / why her / cost of not solving
- `02-scope-cuts-and-non-goals.md` — the smallest useful slice and what you cut
- `03-options-and-opportunity-cost.md` — build vs buy vs do-nothing, grounded in the real calls
- `04-success-metrics-and-feedback-loop.md` — the eval ruler and the Phase-4 decision gate
- `05-skeptical-reviewer-questions.md` — the objections and the answers that hold
- `agent-layer-plan.md` — the parent vision (the documented decisions)
- `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md` — the locked decisions table
- `.aipe/study-system-design/00-overview.md` — the *how* layer this brief sits on top of

# 02 — Scope, Cuts, and Non-Goals

The previous file justified *that* the problem is worth solving. This file justifies *how
narrowly* you scoped it — and scope discipline is itself a senior signal. A staff engineer
is not the one with the longest feature list; it's the one who can name the smallest slice
that validates the premise and defend every cut. This file is the cut list, with the
reasoning attached to each cut.

## Zoom out — the scope onion

See the whole thing the product *could* be, with a hard line drawn around the slice you
actually built.

```
  Zoom out — what's in the slice vs what's deliberately outside it

  ┌─ the full Hermes-shaped vision (NOT the scope) ──────────────────────┐
  │  ░ two-brain body (laptop + phone)   ░ multi-platform gateway        │
  │  ░ multi-app HTTP API   ░ enforced RLS   ░ fine-tuning (the ceiling) │
  │                                                                       │
  │   ┌─ THE SLICE YOU BUILT (v1b) ─────────────────────────────────┐    │
  │   │  ★ one laptop brain ★                                        │    │ ← we are here
  │   │  Gemma + pgvector + chat CLI + trajectory capture            │    │
  │   │  single device · single writer · direct pg · measured        │    │
  │   └──────────────────────────────────────────────────────────────┘    │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The slice is *"one good agent end-to-end with measured eval numbers — not a
platform"* (`agent-layer-plan.md:6`). Everything outside the inner box is named, dated, and
deferred — not forgotten. The discipline that sorts "in" from "out" is reversibility: lock
the one-way doors, defer everything additive (taught in full at
`.aipe/study-system-design/07-deferred-body.md`).

## Structure pass

**Layers:** the scope splits three ways — the slice (built now), the cuts (deferred,
reversible), and the one-way doors (decided now even though not built out, because
reversing them later is expensive).

**Axis — *reversibility. Is this decision a one-way door?*** Trace it across every scope
choice and the sort falls out automatically:

```
  one axis — "is reversing this expensive?" — sorts every scope decision

  decision ─────► is reversing it expensive (a one-way door)?
                    │                              │
                   YES                            NO
                    ▼                              ▼
             DECIDE NOW                    is the seam cheap to scaffold now?
        (embedding dim = 768)               │                    │
                                           YES                   NO
                                            ▼                     ▼
                                   SCAFFOLD NOW            CUT / DEFER
                                (app_id, embedding_model   (phone, sync, gateway,
                                 column, the contracts)     RLS, fine-tuning, HTTP)
```

**Seam:** the `VectorStore` and `CapabilityTraceSink` contracts are the seam every cut
plugs back into later. That's *why* the cuts are safe and not procrastination — each
deferred phase "reuses this schema and the `VectorStore` contract — no rework"
(`...graduation-design.md:188`). The seam is load-bearing because it lets the scope stay
small without painting the growth path into a corner.

## How the slice was chosen — the smallest useful scope

### Move 1 — the mental model

You've shipped a feature behind a flag: the column and the dormant code path go in now,
the feature flips on later, so you never do a big-bang rewrite. The scope here is that move
at the *system* level. Build the laptop brain now with `app_id` and the contracts in place;
the phone, the gateway, and RLS flip on later by plugging into seams that already exist —
no schema migration, no agent rewrite.

```
  the smallest-useful-slice test — does it validate the premise?

  premise to validate:  "I can build the engineering under a real RAG
                         agent AND prove it with numbers"

  smallest slice that validates it:
    ┌────────────────────────────────────────────────────┐
    │ one device · one user · real corpus · real Gemma   │
    │ provider · RAG from scratch · precision@k measured │
    └────────────────────────────────────────────────────┘
       ▲ remove any one and the premise is no longer proven:
         - drop the eval → "built it" but not "measured it"
         - drop RAG-from-scratch → it's a tool config, not engineering
         - drop the Gemma provider → no provider-contract signal
         - add a second device → unproven sync scope, no new proof
```

Notice what the test rejects: **adding** a second device proves nothing new about the
premise — it just adds the sync/merge problem (the hardest part) with no extra evidence
that you can build-and-measure a RAG agent. So it's cut. That's the discipline: the slice
is the *narrowest* thing that still proves the claim, and anything that doesn't add proof
is out.

## The cut list — what's deliberately NOT built, and why each is safe

```
  Phase A — IN the slice (built)        cut → why it's safe to defer

  one laptop brain (Gemma+pgvector)     —
  trajectory capture (messages table)   —
  precision@k / recall@k eval           —
  profile injection (me.md as context)  —
  ────────────────────────────────────  ─────────────────────────────────────────
  CUT: phone brain (RN, on-device)      two brains = sync/merge problem; build
                                        laptop-first so sync is the SECOND thing
                                        solved, not the first (...aptkit-
                                        packages-design.md:76)
  CUT: laptop↔phone memory sync         the buffr canonical-local-with-cloud-mirror
                                        problem; only bites once both brains live
  CUT: HTTP API / Edge Functions        "single device has one client; HTTP API is
                                        YAGNI until phone/app #2" (...graduation-
                                        design.md:27) — adding it later wraps the
                                        same SQL, additive
  CUT: enforced RLS                     unneeded for one user; the app_id column is
                                        scaffolded so RLS flips on with no migration
                                        (...graduation-design.md:29)
  CUT: multi-app consumers              centralize the agent LAYER not the data;
                                        apps keep their schemas, consume later over
                                        HTTP (agent-layer-plan.md:83)
  CUT: fine-tuning                      the CEILING, gated on Phase-4 evidence, never
                                        assumed (agent-layer-plan.md:19); trajectory
                                        capture ships now so it's ANSWERABLE later
  CUT: reranking / hybrid retrieval     dense-only is enough to hit the precision@5
                                        gate for v1; revisit only if retrieval misses
                                        dominate (agent-layer-plan.md:116)
```

Every cut has a citation. That's the point — in the room, "I cut the phone" sounds like
giving up; "I cut the phone because two brains is the sync/merge problem and laptop-first
makes sync the second thing I solve, not the first" sounds like sequencing risk. Same cut,
opposite signal.

## The one-way doors — decided now, on purpose

These are NOT cuts. They're decisions locked early *because* reversing them is expensive,
even though the thing they enable isn't built yet.

```
  one-way doors — what's locked and the cost of reversing it later

  ┌─ embedding dimension = 768 ──────────────────────────────────────────┐
  │  LOCKED. A corpus embedded at nomic's 768 can't be searched by a      │
  │  1536-dim query. Swapping the embedder after indexing = re-embed the  │
  │  WHOLE corpus. So: store carries its dimension, mismatch throws loud,  │
  │  reindex is first-class.   agent-layer-plan.md:115                    │
  └───────────────────────────────────────────────────────────────────────┘
```

Naming a one-way door you decided *early and on purpose* is a stronger signal than any
feature. It says you can tell reversible decisions from irreversible ones — the core of
scoping under uncertainty.

## Non-goals — stated flat, no apology

```
  non-goals — what this project is explicitly NOT

  ✗ NOT a platform        — one agent, measured (agent-layer-plan.md:6)
  ✗ NOT Hermes            — no sub-agents, no skill auto-gen, no fine-tuned
                            models; steals the patterns, not the machinery
                            (agent-layer-plan.md:13-20)
  ✗ NOT a fleet of agents — ship ONE end-to-end, measure, then maybe generalize
  ✗ NOT centralized DATA  — centralize the agent LAYER; apps keep their schemas
  ✗ NOT a product seeking — it's a portfolio + learning project; the audience for
    product-market fit     the evidence is a reviewer, not a market
```

State these without flinching. "This is not a platform" is not a weakness to soften — it's
the deliberate scope that makes the eval numbers meaningful. A platform with no users and
no numbers is weaker than one measured agent with both.

## The principle

The expensive mistake is never building the small thing — it's building the small thing in
a way that forces a rewrite to grow it, or scoping it so broadly that nothing in it is
*proven*. Sort by reversibility: lock the one-way doors, scaffold the cheap seams, defer
everything additive. The slice you keep is the narrowest one that still validates the
premise; every cut plugs back into a seam that already exists. Scope discipline isn't
saying no to features — it's proving you know which decisions are irreversible and which
can wait for evidence.

## Interview defense

**Q: You built a personal agent but it only runs on one device and serves one user. Isn't
that under-scoped?**
It's *correctly* scoped. The premise I'm validating is "I can build the engineering under a
RAG agent and measure it." A single device, single user, real corpus, and a precision@k
gate is the narrowest thing that proves that. A second device adds the sync/merge problem —
the hardest part — with zero additional proof of the premise, so it's deferred, not
dropped. Anchor: smallest-useful-slice + `...aptkit-packages-design.md:76`.

```
  remove any part of the slice → premise unproven
  add a part beyond it → scope to defend with evidence I don't have
```

**Q: How do you know the cuts won't force a rewrite when you do build the phone?**
Because every deferred phase has a named seam it plugs into: the Edge-Fn store → the
`VectorStore` contract; RLS → the `app_id` column already on every table; fine-tuning → the
trajectory already captured. The scaffolding is built; only the policies and adapters are
deferred. Anchor: `...graduation-design.md:188`.

**Q: Why lock the embedding dimension so early?**
Because it's a one-way door for *data*, not code. The adapters keep the code swappable any
time, but a corpus embedded at 768 can't be searched by a 1536-dim query — swapping after
indexing means re-embedding everything. So I locked 768, made the store carry its
dimension, and made mismatch throw loud and reindex first-class. Anchor:
`agent-layer-plan.md:115`.

## See also

- `01-problem-brief.md` — why the problem is worth solving at all.
- `03-options-and-opportunity-cost.md` — build vs buy, and `do nothing` as a real option.
- `.aipe/study-system-design/07-deferred-body.md` — the deferral strategy taught in full.
- `agent-layer-plan.md` — the "what NOT to do" list every cut cites.

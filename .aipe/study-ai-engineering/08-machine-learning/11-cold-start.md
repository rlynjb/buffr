# Cold Start

### *industry: the cold-start problem (new user / new item / new system) · type: recommending when you have no interaction history to learn from*

## Zoom out

A recommender learns from interactions — but at some moment there are none. A brand-new user, a freshly added item, a system on its first day. Cold start is the question "what do you do before the data exists?", and it's the failure mode that kills recommenders in practice. It sits at the front of the pipeline, where data should be but isn't:

**A recommender pipeline, with the cold-start gap at the data stage marked**
```
┌──────────────────────────┐  ┌──────────┐  ┌───────┐  ┌────────┐  ┌──────────┐
│ ★ DATA — but EMPTY ★      │─►│ Features │─►│ Split │─►│ Model  │─►│ Serve    │ ◄── this file
│  no interactions yet:     │  │          │  │       │  │        │  │          │
│  new user/item/system     │  │          │  │       │  │        │  │          │
└──────────────────────────┘  └──────────┘  └───────┘  └────────┘  └──────────┘
        │
   the model downstream is fine — the INPUT is missing, so you fall back
   to CONTENT FEATURES and RULES until interactions accrue
```
Cold start is a data-availability problem, not a modeling problem — the fix is always a fallback to whatever signal *does* exist before history arrives.

## Structure pass

One axis splits the problem into three cases: **which side of the interaction is missing — the user, the item, or the whole system.**

**The one axis: the three cold-starts, with the seam buffr sits on**
```
   NEW USER                 NEW ITEM                 NEW SYSTEM
   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │ user has no   │         │ item has no   │         │ NOTHING has   │
   │ history; items│         │ interactions; │         │ history; no   │
   │ are known     │         │ users known   │         │ users OR items│
   └──────────────┘         └──────────────┘         └──────────────┘
   fix: onboarding,         fix: content                fix: rules +
   popularity priors        FEATURES of the item       content features
                                                        ONLY

   ┌──────────────────────────────── THE SEAM ───────────────────────────────┐
   │ The three cases are NOT the same fix. New-item is the EASY one (you have   │
   │ features). New-system is the HARDEST — no interaction signal exists at all.│
   │ buffr at launch IS the new-SYSTEM case: content features (embeddings) and  │
   │ rules, zero interaction history.                                            │
   └───────────────────────────────────────────────────────────────────────────┘
```
The seam matters because the cases need different fallbacks — and buffr lands on the hardest one, the cold *system*, where only content and rules exist.

## How it works

### Move 1 — Mental model

The mental model: **when interaction history is missing, fall back to the signal that doesn't depend on history — item content features and hand-written rules.** Collaborative signal needs history; content features and rules don't. Cold start is the discipline of bridging from "rules + content only" to "learned from interactions" as data accrues.

**The bridge: from no-history fallback to learned signal**
```
   day 0                                          later
   ┌───────────────────────┐                      ┌───────────────────────┐
   │ NO interactions        │   as users act       │ enough interactions    │
   │ ─► content features    │ ──────────────────►  │ ─► add learned signal  │
   │ ─► rules / popularity   │   accrue history     │   (collaborative, etc.)│
   └───────────────────────┘                      └───────────────────────┘
        the cold-start fallback                       the warm steady state
```
Every cold-start mitigation is a temporary bridge: lean on content and rules now, swap in learned signal once history exists.

### Move 2 — Walk the mechanism

**Part 1 — New user: no history, so seed a profile from onboarding or popularity priors.** You know the items; you don't know this user. Ask a few onboarding questions, or default to what's popular, until they generate signal.

**New user — seed a profile before they've acted**
```
   new user (empty profile)
        │
        ├─ onboarding: "pick 3 topics you care about" ─► instant content profile
        └─ popularity prior: show globally top items   ─► safe default
                          │
                  first interactions accrue ─► profile sharpens
```

**Part 2 — New item: no interactions, but it HAS content features — recommend it by feature similarity.** This is the easy case. The item's own features (text, embedding) place it next to items users already like, so content-based recommends it immediately.

**New item — features bridge the zero-interaction gap**
```
   new item: 0 interactions, but HAS an embedding
        │
        ▼  cosine to existing liked items
   sits near items user already likes ─► recommend it
   ── content features make new-ITEM cold start nearly free ──
```

**Part 3 — New system: nothing exists, so rules and content features are the entire system.** No users, no interactions, often no popularity stats. You ship heuristics and content similarity and accept that "learned" recommendations come later. Illustrative, not buffr code:

**New system — rules + content carry day 0 (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Day-0 recommender with NO history.
def recommend_cold_system(seed_item, all_items):
    scored = [(cosine(seed_item.embedding, it.embedding), it)
              for it in all_items if it.id != seed_item.id]   # content only
    scored = apply_rules(scored, recency_boost=True, diversity_cap=2)  # rules only
    return top_n(scored, n=5)
    # NO collaborative term, NO popularity stats — none exist yet
```

**Part 4 — As history accrues, layer learned signal on top.** The bridge completes: interactions logged today become the training data that lets you add collaborative or learned re-ranking tomorrow.

**The accrual loop — today's interactions are tomorrow's signal**
```
   serve (rules + content)
        │
        ▼  log interactions
   interaction history grows ──► becomes training data
        │
        └─► later: add learned re-ranking / collaborative ─► warm system
```

### Move 2.5 — current vs future

**buffr's cold-start reality, by case**
```
   CASE              buffr's situation                         fallback that applies
   ┌──────────────┬─────────────────────────────────────┬──────────────────────────┐
   │ new USER     │ single-user — "new user" barely exists │ n/a (one user)            │
   │ new ITEM     │ a freshly indexed doc has an embedding  │ content features ✓ (easy) │
   │ new SYSTEM   │ ★ buffr at launch IS this ★             │ rules + embeddings ONLY   │
   └──────────────┴─────────────────────────────────────┴──────────────────────────┘
```
buffr's honest cold-start case is the new *system*: a freshly indexed corpus with embeddings and rules, and zero interaction history to learn from.

### Move 3 — The principle

The principle: **cold start is solved by leaning on the signal that doesn't require history — content features and rules — and treating learned signal as something you earn over time, not something you have on day one.** Don't design a recommender that *needs* interactions to function; design one that works on content + rules from the first request and gets *better* as history accrues. A system that's useless until it has data never collects the data.

## Primary diagram

The full picture — three cold-starts, three fallbacks, and the one buffr actually faces.

**The cold-start map, with buffr's case starred**
```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                  is there interaction history?                          │
   └───────────────────────────────┬────────────────────────────────────────┘
              NO ───────────────────┼──────────────────── YES ─► learned/collaborative
   ┌──────────────┬─────────────────┴─────────────┬──────────────────┐
   ▼              ▼                                ▼
   new USER       new ITEM                         ★ new SYSTEM ★
   onboarding +   content features                 rules + content
   popularity     (item embedding)                 features ONLY
                                                          │
   ┌──────────────────────────────────────────────────────────────────────┐
   │ buffr at launch IS the new-system case: agents.chunks has 768-dim      │
   │ embeddings (content features) and you write recency/diversity rules.   │
   │ There is NO interaction history to learn from yet.                      │
   └──────────────────────────────────────────────────────────────────────┘
```
buffr's launch state is the hardest cold-start cell — and the only tools available are exactly the ones the repo already has: embeddings and rules.

## Elaborate

The sharp edges:

- **New-item is easy, new-system is hard — don't conflate them.** A new item rides on its content features into an existing warm system. A new *system* has no warm context at all; everything is fallback. They feel similar but the available signal is completely different.
- **Popularity priors are a single point of failure for single-user systems.** "Show what's popular" needs a population. buffr has one user, so there's no popularity distribution — its cold-start fallback is content + rules with *no* popularity term.
- **Onboarding is a profile-bootstrapping trick.** Asking a new user to pick topics manufactures a content profile before any interaction — it's how content-based recommenders skip the new-user gap.
- **The accrual loop is the real fix.** Cold start is temporary by design: log interactions from day 0 so you can add learned signal later. `agents.messages` is buffr's accrual log — the place future interaction history would live.
- **buffr's honest line.** buffr at launch is the new-system cold start: `agents.chunks` holds 768-dim embeddings (content features) and you'd hand-write recency/diversity rules — there is no interaction history and, being single-user, no popularity prior either. The mitigations that apply are exactly content features + rules; the ones that don't (collaborative, popularity) require a crowd buffr doesn't have. Logging `agents.messages` is what would let it eventually leave the cold state.

## Project exercises

### Ship a cold-start recommender that works on day 0

- **Exercise ID:** [B2C.11] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Build the new-system fallback explicitly: a recommender that, with *zero* interaction history, returns related chunks using only `agents.chunks` embeddings (content features) plus rules — recency boost, source diversity, exclude-current. No popularity term (single user, no population), no collaborative term. Then design the accrual hook: write down exactly what you'd log to `agents.messages` so the system could later graduate to learned signal.
- **Why it earns its place:** It forces the cold-start discipline — a recommender that's useful before any data exists — and names buffr's real situation honestly: the hardest cold-start case, solved with only the signals the repo already has.
- **Files to touch:** new `ml/cold_start.py` or a CLI command by `src/cli/`, reads `agents.chunks` embeddings via `src/pg-vector-store.ts`, documents the `agents.messages` accrual plan in `ml/README.md`.
- **Done when:** the recommender returns sensible related chunks with no interaction data, applies recency + diversity rules, and a note states plainly (a) why popularity/collaborative fallbacks don't apply to single-user buffr and (b) what would be logged to leave the cold state.
- **Estimated effort:** 1 day.

### Simulate the warm-up curve from cold to learned

- **Exercise ID:** [B2C.11b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. Take captured `agents.messages` (or synthetic interactions), and simulate the accrual loop: start with the content+rules cold-start recommender, then progressively fold in implicit feedback (the user-profile vector from [B2C.10b]) and measure how recommendation quality changes as "history" grows from 0 to N interactions. Plot the warm-up curve.
- **Why it earns its place:** It makes the central principle concrete — that cold start is temporary and learned signal is *earned* — and shows you can reason about the transition rather than treating cold and warm as separate systems.
- **Files to touch:** new `ml/warmup_curve.py`, reads `agents.messages` and `agents.chunks` embeddings, reuses the [B2C.10] recommender, writes the curve to `ml/README.md`.
- **Done when:** a curve shows recommendation quality vs interaction count, the cold-start (0-history) point is the content+rules baseline, and a note states how much history is needed before learned signal beats the rules baseline.
- **Estimated effort:** 1 day.

## Interview defense

Most candidates describe a recommender that needs data to work and never explain what happens on day 0. Knowing the three cold-starts and their distinct fallbacks is the signal you've shipped one, not just trained one.

**Q: A recommender ships with zero data. What do you serve on day 1?**
```
   no history ─► CONTENT features + RULES only
        │
        └─ NOT collaborative (no interactions), NOT popularity if single-user
```
Anchor: day 0 runs on the signal that doesn't need history — content features and rules — and earns learned signal as interactions accrue.

**Q: New user vs new item vs new system — same problem?**
```
   new ITEM    ─► EASY: has content features ─► recommend by similarity
   new USER    ─► onboarding / popularity prior to seed a profile
   new SYSTEM  ─► HARDEST: rules + content ONLY, no signal at all
```
Anchor: three different fallbacks — new-item rides its features, new-user gets onboarded, new-system runs on rules alone.

**Q: Which cold-start is buffr, honestly?**
```
   buffr at launch ─► new SYSTEM
        │
        ├─ agents.chunks embeddings = content features ✓
        ├─ recency/diversity rules ✓
        └─ NO interaction history, NO popularity (single user)
```
Anchor: buffr is the new-system case — the hardest one — armed with exactly embeddings and rules, which is precisely what new-system cold start prescribes.

## See also

- `./10-recommender-systems.md` — the three families; cold start is what each hits before history exists.
- `./09-calibration.md` — cold-start scores are especially untrustworthy as probabilities; calibration is doubly fragile with little data.
- `../03-retrieval-and-rag/` — `agents.chunks` embeddings, the content-feature fallback cold start relies on.
- `../05-evals-and-observability/` — `agents.messages` as the accrual log that lets a cold system warm up.
- `../09-ml-system-design-templates/` — where "must work on day 0 with content + rules" becomes a stated design requirement.

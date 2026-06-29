# 13 — Forbidden patterns and rotating formulas

**Industry term:** forbidden patterns / phrasing rotation · *Language-agnostic* · **not yet exercised in buffr**

LLMs converge on phrasings. Run the same generative chain a hundred times and every output opens "Certainly! Here's…" or closes with the same tidy summary. buffr hasn't hit this yet because it's a Q&A assistant, not a repeated generative chain — but the concept becomes load-bearing the day buffr grows a chain that produces the same *kind* of artifact for one user over and over.

## Zoom out, then zoom in

You've seen autocomplete suggest the same three phrases until your writing sounds like everyone else's. That's convergence, and an LLM does it harder. The fix: explicitly forbid the stock openings and enumerate a rotation of formulas the chain cycles through.

```
  Zoom out — where rotation WOULD live

  ┌─ A repeated generative chain (buffr doesn't have one yet) ─┐
  │  system prompt would carry:                               │
  │    "FORBIDDEN openings: 'Certainly', 'Here's', …"        │ ← not present
  │    "ROTATE among formulas A / B / C; avoid last used"    │ ← not present
  └────────────────────────────────────────────────────────────┘
```

Zoom in: forbidden-patterns prompting lists banned phrasings and rotates among approved formulas, so repeated outputs don't all sound identical. It matters for any generative chain run repeatedly for the same user; it doesn't for one-shot classifiers or structured outputs.

## Structure pass

**Layers:** the chain type (Q&A vs repeated-generative). **Axis — "is this chain run repeatedly to produce the same kind of artifact?":**

```
  axis: "repeated generative chain for one user?"

  ┌─ buffr RagQueryAgent ─┐ NO — answers varied questions  ← convergence
  │                        │      doesn't bite (yet)
  └─ future caption/vlog ──┘ YES — same artifact repeatedly ← rotation needed
     chain (buffr product vision: prose + clips → vlog)
```

**Seam:** the repetition boundary. Convergence only becomes visible when the same chain runs many times for one user — that's the condition that turns this concept on.

## How it works

### Move 1 — the mental model

The kernel: a forbidden list (phrasings the chain may never use) plus a rotation set (approved formulas the chain cycles, avoiding the last-used). What breaks without each: no forbidden list = stock openings creep back; no rotation = every output picks the same "best" formula.

```
  Forbidden-patterns prompting — ban · rotate · remember-last

  ┌─ FORBIDDEN: "Certainly", "Here's", "In conclusion" ─┐
  ├─ ROTATE: formula A / B / C ─────────────────────────┤
  └─ avoid the formula used last time ──────────────────┘
       (needs rotation history — state across runs)
```

### Move 2 — why buffr doesn't need it yet, and when it will

**buffr's chain answers varied questions.** The RAG agent ([06](06-single-purpose-chains.md)) responds to different questions each turn, so its outputs don't converge into a recognizable sameness — there's no single artifact being regenerated. The synthesis prompt asks for "direct and concise" ([09](09-chain-of-thought.md)), which doesn't invite a stock opening. So convergence hasn't surfaced.

**Where it'll bite — the product vision.** buffr's larger product is a multi-source compose pipeline: prose + clips → vlog ([me.md system-design portfolio]). The moment buffr has an AI-assisted *caption* or *vlog-intro* chain that runs every time the user composes, that chain produces the same kind of artifact repeatedly for one user — and without a forbidden list and rotation, every caption will open the same way and the user will notice within a week.

**The state requirement.** Rotation needs memory of what was used last — a rotation history per user/chain. buffr already has a memory substrate (conversation memory, [00-overview.md](00-overview.md)) that could carry "last formula used," so the infrastructure to support rotation exists before the chain that needs it does.

**When it doesn't apply.** One-shot classifiers and structured outputs ([02](02-structured-outputs.md)) — convergence there is *fine*, even desirable (you *want* the classifier to always emit the same schema). Forbidden-patterns is strictly a generative-variety concern.

### Move 3 — the principle

For any generative chain run repeatedly for one user, ban the stock phrasings and rotate among formulas with a memory of the last one used. Convergence is invisible until repetition makes it visible — so the concept is dormant in a Q&A assistant and urgent in a content generator. buffr is the former today and the latter in its product roadmap.

## Primary diagram

```
  forbidden-patterns — dormant now, urgent for the product vision

  buffr today (Q&A)              buffr's vlog/caption chain (future)
  ┌─ varied questions →   ┐      ┌─ same artifact repeatedly →     ┐
  │  no convergence       │      │  FORBIDDEN list + ROTATE formulas│
  │  no rotation needed   │      │  + rotation history (per user)   │
  └───────────────────────┘      └──────────────────────────────────┘
```

## Project exercises

### EX-13-A — Forbidden-openings + rotation for a generative chain

- **Exercise ID:** EX-13-A
- **What to build:** When buffr adds an AI-assisted caption/intro chain, give its system prompt a forbidden-openings list and a rotation set, and store the last-used formula in the existing conversation-memory substrate so the next run avoids it.
- **Why it earns its place:** Prevents the every-output-sounds-the-same convergence the moment a repeated generative chain ships — the failure a user notices fastest.
- **Files to touch:** the new generative chain's prompt; the memory write/read for rotation history (`createConversationMemory` substrate).
- **Done when:** N consecutive runs for one user produce N distinct openings, verified by an eval that flags repeated openings.
- **Estimated effort:** M.

## Interview defense

**Q: Why doesn't this system rotate phrasings, and when would it need to?**

Because it's a Q&A assistant answering varied questions — there's no single artifact being regenerated, so phrasing convergence doesn't show. It'd need rotation the moment it grows a repeated generative chain, like the caption chain in buffr's vlog-compose roadmap: same kind of output every time, which converges on a stock opening within a few runs.

```
  varied Q&A → no convergence | repeated artifact → ban + rotate + remember-last
```

Anchor: *"The part people forget is the rotation history — rotation needs state, a memory of the last formula used, or it just re-picks the same one. buffr already has a conversation-memory substrate that could carry it, so the infrastructure is there before the chain that needs it. And I'd never apply this to classifiers — there, converging on the same schema is the goal."*

## See also

- [00-overview.md](00-overview.md) — the memory substrate that could carry rotation history
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the current chain that doesn't converge
- [02-structured-outputs.md](02-structured-outputs.md) — structured outputs, where convergence is fine

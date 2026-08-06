# Deep session facade — createChatSession, and what happens when a facade keeps growing

**Industry names:** the facade pattern · a deep module · the session
object · resource-holding object (RAII-ish) · (informally) a god object,
when a facade stops earning that name. **Type:** Industry standard.

Roughly thirty constructed things — pool, embedder, vector store, journal
store, retrieval pipeline, up to seven tool wrappers, the model, the
profile, the memory engine, five cached connectors, the investing engine,
the research engine, the conversation id, the trace sink, the routing
prompt registry, the agent — wired together once in `createChatSession`
(`session.ts:394-665`) and held warm across a whole session. What sits
behind the door has stayed the shape this file has always taught: a
genuinely deep subsystem, built once, cheap to call repeatedly. What has
changed since the last pass through this file is the **door itself** —
`ChatSession` (`session.ts:102-126`) went from two exposed verbs at this
file's first version to four at the last update to **fifteen now**, and
those fifteen span four distinct product surfaces: chat, investing,
market research, and the decision journal. This update is as much about
that growth as about the facade's mechanics — the honest read is that the
door has widened enough to be worth naming as its own finding.

Role-vocabulary (facade + deep module), named once:

- **the facade** — the `ChatSession` interface (`session.ts:102-126`):
  fifteen methods across four domains. The door — now a wide one.
- **the subsystem** — the ~30 wired pieces behind it (the agent, two
  engines, the store, the journal store, memory, trace, pool,
  conversation, five connectors, up to seven tools).
- **the client** — `cli/chat.tsx` (calls 8 of the 15 methods directly),
  plus `research-flow.ts` and `review-flow.ts` (each calls a disjoint
  slice of the remaining 7). Three clients now, not one.
- **the resource** — the warm `pg.Pool` and the single `conversationId`
  held across turns; what `close()` releases.

---

## Zoom out, then zoom in

The facade still sits between the UI and the entire agent subsystem — but
"the UI" is no longer one file calling two verbs. It's three files, each
calling a different slice of a much wider interface.

```
  Zoom out — three clients, one facade, four bundled domains

  ┌─ UI layer (OpenTUI) ───────────────────────────────────────────────┐
  │  cli/chat.tsx        research-flow.ts       review-flow.ts          │
  │  ask · analyze ·     researchCollect ·      listDueReviews ·        │
  │  evalInvesting ·     researchEvaluate ·     snoozeReview ·          │
  │  evalResearch ·      saveHypothesis ·       resolveReview           │
  │  suggestResearch     saveDecision                                    │
  │  Topics ·                                                            │
  │  connectorStatus ·                                                   │
  │  dueReviewCount ·                                                    │
  │  close                                                               │
  └────────────┬──────────────────┬─────────────────┬────────────────────┘
               │ 8 methods        │ 4 methods        │ 3 methods
               │ (chat/meta)      │ (research)       │ (journal review)
  ┌─ Session facade: createChatSession ▼──────────────────────────────┐ ← here
  │  ★ ChatSession ★  — 15 methods, 4 domains, ONE factory function     │
  │   build-once: ~30 constructed things (pool, both engines, store,    │
  │   journalStore, memory, 5 connectors, trace, agent, ...)            │
  └───────────────────────────┬──────────────────────────────────────────┘
                              │ orchestrates aptkit-derived kernel + Postgres
  ┌─ Storage + engines ────────▼──────────────────────────────────────────┐
  │  RagQueryAgent · InvestingEngine · MarketResearchEngine ·             │
  │  agents.{chunks,messages,conversations,decisions}                     │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in: the mechanics that made this a *deep* facade — build the
expensive subsystem once, hold the warm resources across turns, expose
only verbs — are unchanged and still correct. What's new is a second
question this file now has to answer honestly: at fifteen methods across
four domains, is `createChatSession` still one cohesive facade, or has it
become four facades wearing one trenchcoat? The verdict, worked out below:
**still not a god object** (no method exposes internals; every method
still hides real machinery) **but the breadth is a real cost**, and the
fix is nameable.

---

## The structure pass

**Layers:** UI (three clients now) · the `ChatSession` facade · the
subsystem (two engines + the RAG agent + the journal store) · storage
(Postgres).

**The axis: what lives for one turn vs the whole session — and now, a
second axis: which domain does this method belong to?** The lifetime axis
from the original version of this file still holds and is still the
reason the facade is deep, not thin:

```
  axis 1 traced = "how long does this live?"   (unchanged from before)

  ┌─ any client ────┐ seam  ┌─ createChatSession ──────────────────┐
  │ holds session   │ ══╪══►│ SESSION-lifetime (built once):        │
  │ for whole run   │       │  pool · both engines · journalStore · │
  │                  │       │  agent · conversationId               │
  │                  │       │ ────────────────────────────────────  │
  │                  │       │ TURN-lifetime (per method call):      │
  │                  │       │  question · topic · prediction · id   │
  │                  │       └────────────────────────────────────────┘
  └──────────────────┘        the facade owns BOTH lifetimes still

  axis 2 traced = "which domain owns this method?"   (the NEW question)

  chat        → ask, connectorStatus, close
  investing   → analyze, evalInvesting
  research    → researchCollect, researchEvaluate, evalResearch,
                suggestResearchTopics
  journal     → saveHypothesis, saveDecision, dueReviewCount,
                listDueReviews, snoozeReview, resolveReview
```

The second axis is the one that matters for this update. Trace it across
the *callers*, not the facade's own body, and something falls out for
free: **the callers already partition themselves along it.** `chat.tsx`
never calls a journal method; `review-flow.ts` never calls a research
method; `research-flow.ts` never calls `analyze`. Nobody actually needs
the flat fifteen-method surface — each client already only reaches for
its own domain's slice. That's the seam a refactor would cut along, and
it's visible in the code today without inventing anything: the boundary
already exists in *usage*, it just isn't reified in the *type*.

---

## How it works

### Move 1 — the mental model

You still know the base shape from frontend: a custom hook like
`useChat()` that wires up state, a socket, retry logic, and returns
`{ send, reset }` — a facade that holds state across renders. What's new
here is the failure mode of that pattern at scale: imagine `useChat()`
had grown, feature by feature, into `useEverything()` — chat, billing,
notifications, settings, all behind one hook, because each new feature
was "just one more method" on something that already existed and already
had the wiring. Nothing about any single addition was wrong. The sum is a
hook nobody wants to read top to bottom anymore, even though each part is
still individually well-built. `createChatSession` is at that inflection
point, not past it.

In one sentence: **a facade stays deep as long as each new verb still
hides real machinery — but a facade that accretes verbs from unrelated
domains, one reasonable addition at a time, eventually needs to be read
as multiple facades sharing infrastructure, not one facade with a long
method list.**

```
  From a narrow door to a wide one — the growth this file has tracked

  v1 (first sync):     ask, close                              2 methods
  v2 (prior sync):      + analyze, evalInvesting                4 methods
  v3 (this sync):        + evalResearch, suggestResearchTopics,
                          connectorStatus, researchCollect,
                          researchEvaluate, saveHypothesis,
                          saveDecision, dueReviewCount,
                          listDueReviews, snoozeReview,
                          resolveReview                        15 methods
                                                     4 domains, 1 factory
```

### Move 2 — the walkthrough

**1. Build once — still true, and now bigger.** The build-once block
(`session.ts:394-665`) is roughly 270 lines now, not the dozen-odd of the
first version. It still runs exactly once per session and still front-
loads every expensive thing: the pool, five cached connectors
(`session.ts:459-469`), both engines (`investingEngine`,
`researchEngine`, `session.ts:516-561`), the journal store
(`session.ts:410`), the routing prompt registration
(`session.ts:596-597`). Nothing here contradicts the original thesis —
build-once is exactly as sound at 30 constructions as it was at 11. The
cost of a wider subsystem is paid once, same as before.

**2. The fifteen methods, grouped by what they actually hide.** This is
the walkthrough the old version of this file doesn't have, because there
weren't four domains to separate yet. Four representative methods, one
per domain, each still deep on its own terms:

```ts
// session.ts:668-692 — chat domain: ask() still does its original 4-step job
async ask(question: string, opts?: AskOptions): Promise<string> {
  currentOnStatus = opts?.onStatus; currentOnTokens = opts?.onTokens;
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);
  await supabaseTrace.flush();
  try { await memory.remember({ conversationId, question, answer }); } catch { /* swallow */ }
  return answer;
}
```

```ts
// session.ts:713-726 — research domain: researchCollect() hides the fan-out
async researchCollect(topic: string, opts?: ResearchCallbacks): Promise<{ collected: CollectedResearch }> {
  const agentCtx: AgentContext = { userId: cfg.appId, workspaceId: cfg.appId,
    traceId: `research-collect-${topic}-${Date.now()}`, domain: 'market-research',
    now: new Date().toISOString(), permissions: [] };
  const result = await researchEngine.collect({ topic, conversationId, onStatus: opts?.onStatus, onProgress: opts?.onProgress }, agentCtx);
  return { collected: result.data };
}
```

```ts
// session.ts:784-790 — journal domain: dueReviewCount()/listDueReviews() are one line each
async dueReviewCount(): Promise<number> {
  const due = await journalStore.listDue(cfg.appId, cfg.appId, new Date().toISOString());
  return due.length;
}
async listDueReviews(): Promise<JournalEntry[]> {
  return journalStore.listDue(cfg.appId, cfg.appId, new Date().toISOString());
}
```

Every one of these is individually *deep* by the same test the original
`ask()`/`close()` passed: a one-or-two-line body hiding a real subsystem
call (`researchEngine.collect`, `journalStore.listDue`, the four-step
`ask` sequence). None of the fifteen methods is a pass-through with no
abstraction of its own. **The problem isn't depth-per-method — it's that
`AgentContext` construction (`userId`/`workspaceId`/`traceId`/`domain`/
`now`/`permissions`) is now hand-repeated at four separate call sites**
(`session.ts:695-697`, `715-722`, `732-739`, `852-859`) with only
`domain` and `traceId` actually varying — the kind of small, repeated
knowledge the audit's information-hiding lens (lens 3) would flag if it
crossed *module* boundaries; here it's the same knowledge repeated
*inside* one module, four times, because that module now serves four
domains.

**3. The client partition — proof the domain boundary is real, not
invented.** `cli/chat.tsx` imports `createResearchFlow` and
`createReviewFlow` (`chat.tsx:6-7`) and hands each its own `session`
reference — but `research-flow.ts` only ever calls `researchCollect`,
`researchEvaluate`, `saveHypothesis`, and `saveDecision`; `review-flow.ts`
only ever calls `listDueReviews`, `snoozeReview`, and `resolveReview`.
`chat.tsx` itself calls the remaining eight (`ask`, `analyze`,
`evalInvesting`, `evalResearch`, `suggestResearchTopics`,
`connectorStatus`, `dueReviewCount`, `close`). Nobody calls across the
boundary. That's the evidence for the fix named in Move 3 — the split
this facade wants isn't hypothetical, it's already the shape the callers
independently converged on.

```
  Layers-and-hops — who calls what (the partition already exists)

  ┌─ chat.tsx ──────┐  ask · analyze · evalInvesting · evalResearch ·
  │                  │  suggestResearchTopics · connectorStatus ·
  │                  │  dueReviewCount · close              (8 methods)
  └──────────────────┘         ▲
  ┌─ research-flow.ts ┐  researchCollect · researchEvaluate ·
  │                    │  saveHypothesis · saveDecision      (4 methods)
  └────────────────────┘         ▲          all against
  ┌─ review-flow.ts ──┐  listDueReviews · snoozeReview ·      ONE session
  │                    │  resolveReview                       object
  └────────────────────┘  (3 methods)      (15 total, 0 overlap)
```

**4. `close` — unchanged, still the one-line teardown.** The resource
half of the facade hasn't grown at all:

```ts
// session.ts:876-881
async close(): Promise<void> {
  await Promise.race([pool.end(), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
}
```

(The 1-second race is new since the last pass and belongs to
`study-runtime-systems` / a shutdown-hardening story, not this file —
noted here only because it's the one line in the facade that changed for
a reason unrelated to domain growth: a hung `pool.end()` used to freeze
CLI exit.)

### Move 3 — the principle, updated

The original principle still holds at the level of a single verb: a
facade is worth building when the interface it exposes is dramatically
smaller than the subsystem it hides, and it's *deep* when it also owns
the subsystem's lifecycle. `createChatSession` still does both — every
one of its fifteen methods clears that bar individually. What this
update adds is the principle for what happens **next**, after a deep
facade has been correctly built and then kept growing by "just one more
verb" additions that are each individually justified: **the failure mode
isn't shallowness, it's scope creep across an interface that never
stopped to ask "is this still one job?"** The fix Ousterhout would name
is the one the callers already demonstrate: split by who actually calls
what. Concretely, that means a shared session context (the ~30
build-once constructions, unchanged) with four thin, domain-scoped
facades layered on top — `createChatFacade`, `createInvestingFacade`,
`createResearchFacade`, `createJournalFacade` — each exposing only its
own methods, each still backed by the one build-once subsystem. `ask()`
would still be one line to call; it just wouldn't sit in the same object
as `resolveReview()`. Nothing about the subsystem wiring changes; only
the door gets split back into four doors, matching the four rooms that
already exist behind it.

---

## Primary diagram

```
  createChatSession — the widening facade, full recap

  ┌─ UI: 3 clients, each calling its own slice ──────────────────────┐
  │  chat.tsx (8)        research-flow.ts (4)     review-flow.ts (3)  │
  └────────────┬──────────────────┬─────────────────┬─────────────────┘
               │                  │                  │  15 methods total,
               │                  │                  │  0 cross-domain calls
  ┌─ Facade: createChatSession ▼──▼──────────────────▼──────────────┐
  │  BUILD ONCE (~30 constructions): pool · embedder · store ·        │
  │   journalStore · both engines · memory · 5 connectors · agent ·   │
  │   conversationId · trace · promptRegistry                          │
  │                                                                     │
  │  chat: ask · connectorStatus · close                                │
  │  investing: analyze · evalInvesting                                 │
  │  research: researchCollect · researchEvaluate · evalResearch ·      │
  │            suggestResearchTopics                                     │
  │  journal: saveHypothesis · saveDecision · dueReviewCount ·           │
  │           listDueReviews · snoozeReview · resolveReview               │
  │                                                                        │
  │  ← the fix: reify these 4 groupings as 4 thin facades over 1 subsystem │
  └───────────────────────────────┬────────────────────────────────────────┘
                                  ▼
  ┌─ subsystem + Postgres ────────────────────────────────────────────────┐
  │  RagQueryAgent · InvestingEngine · MarketResearchEngine ·               │
  │  agents.{chunks,messages,conversations,decisions}                        │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The facade pattern (Gang of Four) gives a unified, simpler interface to a
subsystem. Ousterhout's *deep module* framing sharpens "unified" into a
testable claim: small interface, big behavior. Neither framing has an
opinion about what happens when a facade that started deep keeps
absorbing unrelated responsibility over many small, individually-correct
commits — that's closer to what Ousterhout calls a module that "hasn't
picked a lane," and in the god-object literature it's the textbook growth
path: no single commit looks like a violation, the violation is only
visible in the diff across many commits, which is exactly why this
generator re-walks `session.ts` on every update instead of trusting the
last verdict.

The resource-holding angle (RAII / `using`/`defer`) is unchanged: acquire
the pool on construction, release it in `close()`. That half of the
facade's job hasn't grown and doesn't need to.

This facade is still the client side of three other patterns in this
guide — it constructs the adapters (`01-adapter-behind-a-contract.md`,
now including `PgJournalStore`), injects everything up into the kernel
(`03-dependency-as-a-boundary.md`), and flushes the observer
(`04-sync-interface-async-work.md`). It's also now the client that holds
both engine topologies (`06-capability-as-typed-computation-unit.md`'s
linear pipeline and `07-collect-then-evaluate-split.md`'s checkpointed
one) — the facade doesn't care which topology a given engine uses, which
is itself a small piece of evidence that the facade's *build-once* half
is still well-designed even as its *interface* half needs a split.

---

## Interview defense

**Q: Is `createChatSession` a facade or a god object?** Still a facade,
by the tell that mattered before: it exposes nothing of its ~30 internal
constructions, and every method still hides real machinery — none of the
fifteen is a bare pass-through. A god object's defining sin is leaking
internals *and* accreting unrelated duties with no boundary at all. This
has the second half of that (four domains, one object) without the
first (nothing leaks). Call it a facade under scope pressure: structurally
sound, outgrowing its single-object shape.
*Anchor:* "nothing leaks, so it's not a god object by the classic test —
but four domains behind one interface is the same growth pattern a god
object starts from, just caught earlier."

```
  facade (still true)          scope creep (the real finding)     god object (not this)
  ┌──────────────┐             ┌──────────────────────┐          ┌──────────────┐
  │ 30 held      │             │ 30 held, 15 exposed,  │          │ internals    │
  │ 15 exposed   │             │  4 domains, 0 grouping │          │ leak         │
  │ each deep    │             │  in the TYPE (though   │          │ + unrelated  │
  └──────────────┘             │  callers already split) │          │ duties       │
                                └──────────────────────┘          └──────────────┘
```

**Q: Why not just split it now?** Because the split is cheap precisely
*because* nothing leaks yet — the four domain groupings share the same
build-once block and the same closure-captured state (`pool`,
`conversationId`, `currentOnStatus`), so four thin facades layered over
one shared context is a mechanical extraction, not a redesign. The
longer this waits, the more likely a method starts reaching across
domains (a research method touching investing state, say) in a way that
makes the later split a real refactor instead of a rename. The audit
(lens 8) marks this a genuine "fix soon," not a "fix eventually."
*Anchor:* "the split is cheap today because the domains don't touch each
other yet — that's the window, and it closes as soon as one method
starts reaching across the boundary."

**Q: Why is `memory.remember` still wrapped in a swallow but the agent
run isn't?** Unchanged from the original answer, and it still applies to
`ask()` specifically: if `agent.answer` throws there's no answer to
return, so the failure *is* the turn; `memory.remember`'s failure would
cost the user an answer they already have, so it's last and swallowed
(`session.ts:686-690`). This particular design choice didn't change as
the facade grew — it's scoped to one method, not the object.
*Anchor:* "the swallow is deliberate and local to `ask()` — the facade's
growth elsewhere didn't touch this decision."

---

## See also

- `01-adapter-behind-a-contract.md` — the `PgVectorStore` and
  `PgJournalStore` adapters this facade constructs.
- `03-dependency-as-a-boundary.md` — the injection wiring done in the
  build-once block.
- `04-sync-interface-async-work.md` — `trace.flush()` called in `ask`.
- `06-capability-as-typed-computation-unit.md` /
  `07-collect-then-evaluate-split.md` — the two engine topologies this
  facade holds and calls into.
- `audit.md` lenses 1, 2, 8 — the size/complexity hotspot, the depth
  verdict, and the "God class / over-large module" red flag this file's
  growth now trips.

# Tech support chatbot system design

- **The prompt:** "Design a tech support chatbot that answers customer questions, escalates when it can't, and learns from agent corrections."

- **Standard architecture:**

  ```
  User message
    │
    ▼
  ┌──────────────────────────────────┐
  │ Intent classification            │
  │  (heuristic + LLM)               │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ RAG over knowledge base          │
  │  (docs, past tickets, runbooks)  │
  └──────────────┬───────────────────┘
                 │  retrieved context
                 ▼
  ┌──────────────────────────────────┐
  │ Constrained LLM response         │
  │  (grounded, cite-or-refuse)      │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Escalate  ◄──── confidence gate  │
  │  or respond                      │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Feedback loop                    │
  │  (agent corrections → eval set)  │
  └──────────────────────────────────┘
  ```

- **Data model:**
  - Knowledge base — docs, past tickets, runbooks chunked + embedded; in buffr this is `chunks` with a 768-dim vector, queried by `search_knowledge_base`.
  - Conversation log — full message trajectory `{role, content, tool_calls, tool_results}`; buffr has exactly this in `agents.messages`, persisted by `src/supabase-trace-sink.ts`.
  - Intent labels — `{message, intent, confidence}`; buffr has none.
  - Correction store — `{conversation_id, agent_correction, original_response}`; buffr has none, but the trajectory in `agents.messages` is the substrate one would attach corrections to.

- **Key components:**
  - *Intent classification*: routes a message to KB-lookup vs account-action vs escalate. Decision: heuristic-first (keyword + length), LLM only on ambiguous messages — cheaper and faster on the common case.
  - *RAG over KB*: retrieves grounding context for the answer; buffr's `PgVectorStore.search` in `src/pg-vector-store.ts` and the bounded loop in `src/session.ts` are this core. Decision: cosine HNSW retrieval, top-k bounded.
  - *Constrained response*: cite-or-refuse — answer only from retrieved context, refuse below a relevance threshold. Decision: a relevance-threshold refusal gate, because hallucinating a support answer is worse than admitting ignorance.
  - *Escalate-or-respond*: hands off to a human when confidence is low. Decision: gate on retrieval confidence + answer-faithfulness, not on the LLM's self-reported certainty (it's unreliable).
  - *Feedback loop*: agent corrections become labeled eval rows. Decision: turn every correction into a regression case so the system can't re-break a fixed answer.

- **Scale concerns:**
  - At ~10k convos/day: repeated questions dominate; cache common Q→A pairs to cut both latency and token cost. The buffr trace table (`agents.messages`) grows fast — every turn, tool call, and tool result is persisted by `src/supabase-trace-sink.ts`.
  - At ~100k convos/day: the trace table becomes the storage and query bottleneck. Solution: partition by day, roll cold trajectories to cheap storage, keep a hot index for the feedback loop.
  - At rising load: the LLM generation step (`gemma2:9b` locally) is the throughput ceiling. Solution: batch, queue with backpressure, escalate to humans when the queue exceeds an SLA threshold.

- **Eval framing:**
  - Offline: answer faithfulness (is the answer grounded in retrieved context?), retrieval recall@k over a labeled ticket set, escalation precision/recall. buffr has precision@1/recall@3 wired in `src/cli/eval-cmd.ts` but **faithfulness (RubricJudge) is unwired**.
  - Online: deflection rate (resolved without a human), escalation rate, agent-correction rate, CSAT. buffr measures none — it's single-user.
  - The correction rate *is* the learning signal: a falling correction rate over time is the system learning from agent fixes.

- **Common failure modes:**
  - Confident hallucination → the bot invents a fix that doesn't exist. Mitigation: the relevance-threshold refusal gate buffr is missing — refuse rather than answer below a retrieval-confidence floor.
  - Over-escalation → everything goes to a human, the bot adds no value. Mitigation: tune the confidence gate, track deflection rate as the counter-metric.
  - Stale KB → the bot answers from a deprecated runbook. Mitigation: re-embed on doc edit, version the KB.
  - Feedback loop poisoning → a bad correction becomes a bad eval row. Mitigation: review corrections before they enter the eval set; weight by agent seniority.

- **Applies to this codebase:** **partially.** buffr's RAG-over-corpus plus the bounded agent loop in `src/session.ts` (one tool, `search_knowledge_base`, maxTurns/maxToolCalls bounds, forced synthesis) is structurally a chatbot's RAG core — the retrieve-then-ground-then-answer spine is identical. But buffr is a single-user personal-knowledge tool, not a support system. There is no intent classification, no escalation path, no human-in-the-loop, and no feedback or correction logging. Critically there is also no relevance-threshold refusal: buffr will synthesize an answer even when retrieval returns weak context, where a support bot must refuse. The one thing buffr *does* have for free is the substrate a feedback loop needs — the full trajectory trace in `agents.messages`, persisted by `src/supabase-trace-sink.ts`, is exactly where corrections would attach.

- **How to make it apply:** Three concrete additions. (1) Add intent gating before the loop in `src/session.ts` — cheap heuristic routing to decide whether to retrieve at all. (2) Add a relevance-threshold refusal: after `PgVectorStore.search` in `src/pg-vector-store.ts` returns, refuse to synthesize below a cosine-distance floor (cross-link the refusal exercise in `03-retrieval-and-rag/11-rag.md`). (3) Wire the unwired RubricJudge faithfulness scoring (cross-link `05-evals-and-observability/`) into `src/cli/eval-cmd.ts` as the "learn from corrections" eval — every trajectory in `agents.messages` is a correction-log candidate, and a faithfulness score per turn is the signal that closes the loop.

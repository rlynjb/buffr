# System design template — tech support chatbot

> Updated: 2026-06-24 — noted buffr's interactive `chat` surface and retrieval-based conversation memory (`08-conversation-memory.md`) as the conversation-history half this template wants.

> Interview reframe, not a codebase pattern. Fixed 9-bullet shape. "Applies to this codebase" and "How to make it apply" are answered about buffr's real files.

- **The prompt:** "Design a tech support chatbot for a product. It must answer customer questions, escalate when it can't, and learn from agent corrections."

- **Standard architecture:**

```
  User message
    │
    ▼
  ┌──────────────────────────────────┐
  │ Intent classification            │
  │  (heuristic + LLM)               │
  └──────────────┬───────────────────┘
                 ▼
  ┌──────────────────────────────────┐
  │ RAG over knowledge base          │
  │  (docs, past tickets, runbooks)  │
  └──────────────┬───────────────────┘
                 ▼
  ┌──────────────────────────────────┐
  │ LLM response generation          │
  │  (constrained to retrieved KB)   │
  └──────────────┬───────────────────┘
            ┌────┴─────┐
            ▼ confident ▼ unsure / out-of-scope
       Respond     ┌──────────────────┐
                   │ Escalate to      │
                   │ human agent      │
                   └────────┬─────────┘
                            ▼
                   Agent answer logged
                   for KB update
```

- **Data model:**
  - Knowledge base: docs, FAQs, past resolutions — chunked, embedded, indexed.
  - Conversation history per user `{turn, role, content, tools_called, confidence, escalated}`.
  - Escalation log linking bot conversations to human-resolved outcomes (the training signal).
  - Feedback log: thumbs up/down per response, free-text agent corrections.

- **Key components:**
  - *Intent classification*: detect category before retrieval. Decision: heuristic/keyword first, LLM classifier on ambiguous cases.
  - *RAG retrieval*: hybrid over the KB, scoped by intent to cut noise. Decision: chunk by section, not by token, for coherent chunks.
  - *Response generation*: LLM constrained to cite retrieved chunks. Decision: refuse if no chunk clears a relevance threshold — escalate rather than hallucinate.
  - *Escalation*: rule-based gate (out-of-scope, low confidence, or "agent please") hands off with full context.
  - *Feedback loop*: agent corrections logged as gold responses, fed back into the eval set.

- **Scale concerns:**
  - At ~10k conversations/day: LLM cost dominates. Solution: cache common Q-A pairs, route easy questions to a cheaper model.
  - At ~100 escalations/day: human agents bottleneck. Solution: prioritize the queue by user value, surface a draft for the agent to edit.
  - At ~1M KB chunks: retrieval latency grows. Solution: tiered retrieval (intent-scoped first, full corpus on miss), precompute hot embeddings.

- **Eval framing:**
  - Offline: golden set of resolved tickets (bot answer vs human answer, rubric-scored).
  - Online: resolution rate without escalation, time-to-resolution, CSAT.
  - Adversarial set: prompt-injection attempts, out-of-scope questions, hostile users.

- **Common failure modes:**
  - Hallucinated answers when the KB has nothing. Mitigation: relevance-threshold gate, refuse + escalate.
  - Prompt injection in user messages. Mitigation: sanitize, never let the LLM emit privileged actions.
  - Stale KB — bot describes a deprecated feature. Mitigation: KB freshness SLA, re-embed on doc change.
  - Tone drift. Mitigation: persona in the system prompt, rubric scores tone adherence.

- **Applies to this codebase:** `partially`. buffr's spine *is* a chatbot's RAG-over-KB spine: index a corpus (`01-rag-index-path.md`), retrieve grounded chunks (`02-rag-query-path.md`), and generate an answer constrained to those chunks via a bounded agent loop (`03-agent-loop-with-tool-calling.md`) — and the system prompt already says "if the knowledge base does not contain the answer, say so plainly rather than guessing," which is the refuse-don't-hallucinate gate this template wants. It runs as an interactive multi-turn `chat` surface (`src/cli/chat.tsx` → `src/session.ts`) holding one warm conversation, captures the full conversation trajectory to `agents.conversations`/`messages` (`src/supabase-trace-sink.ts`, all six events), and now also has retrieval-based conversation memory — past exchanges are embedded and recalled by similarity across sessions (`08-conversation-memory.md`), which is the recallable conversation-history half this template wants. What makes it only *partial*: buffr is a personal knowledge agent, not a support system, so there's no intent classification before retrieval, no escalation path (no human agent to hand off to), no confidence-thresholded refuse (the refusal is prompt-instructed, not score-gated), no feedback/correction loop, and no faithfulness eval (`06-evals-precision-and-recall.md` scores retrieval only).

- **How to make it apply:** Against buffr's real files: (1) Add a score-gated refusal — the search tool already returns a `score` per hit (`src/pg-vector-store.ts:72`); thread a threshold so the agent refuses when the top score is below it, turning the prompt-instructed refusal into a measured one. (2) Add the feedback loop — a `feedback` table and a CLI to mark an answer good/bad, then fold flagged-bad queries into `eval/queries.json` as a regression set (`06`'s exercise). (3) Add a faithfulness judge (`06`'s primary exercise) so "did the answer follow from the KB?" is scored — the core quality metric a support bot lives or dies on. Honest framing for an interview: "I haven't built a support bot, but my personal RAG agent shares its retrieve-ground-refuse spine; here's the exact diff — score-gated refusal, a feedback table, and a faithfulness eval — that turns it into one."

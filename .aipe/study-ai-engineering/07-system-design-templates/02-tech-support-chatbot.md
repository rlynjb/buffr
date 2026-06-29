# Tech-Support Chatbot — interview reframe

## The prompt

> Design a tech-support chatbot that answers user questions, escalates to a human when it can't, and learns from corrections.

## Standard architecture

```
            Tech-support chatbot — answer · escalate · learn
┌──────────────────────────────────────────────────────────────────────┐
│                          user message                                  │
│                                │                                       │
│                                ▼                                       │
│                      ┌──────────────────┐                              │
│                      │ intent classifier │  FAQ? account? bug? chitchat │
│                      └──────────────────┘                              │
│                                │                                       │
│              ┌─────────────────┼─────────────────┐                     │
│              ▼                 ▼                 ▼                      │
│        ┌──────────┐     ┌──────────────┐   ┌──────────┐                │
│        │ canned /  │     │  RAG answer   │   │  action / │                │
│        │ FAQ path  │     │  over KB      │   │  tool API │                │
│        └──────────┘     └──────────────┘   └──────────┘                │
│                                │                                       │
│                                ▼                                       │
│                      ┌──────────────────┐                              │
│                      │ confidence gate   │  grounded? confident?        │
│                      └──────────────────┘                              │
│                          │            │                                │
│                  yes ────┘            └──── no                          │
│                   ▼                          ▼                          │
│            answer to user           ┌──────────────────┐               │
│                   │                 │  ESCALATE to human │               │
│                   ▼                 │  (handoff + ctx)   │               │
│         ┌──────────────────┐        └──────────────────┘               │
│         │ feedback / thumbs │◄────────────┘                            │
│         │ + agent correction │ ──► correction log ──► KB / fine-tune    │
│         └──────────────────┘                                          │
└──────────────────────────────────────────────────────────────────────┘
```

Three jobs, three subsystems: a router that picks a path, a grounded answerer with a confidence gate in front of escalation, and a correction loop that turns human fixes back into system knowledge.

## Data model

- **Knowledge base** — chunked + embedded support docs / past tickets; the answer path retrieves over this. This is buffr's `agents.chunks`.
- **Conversation transcript** — per-session message history with roles, tool calls, and tool results. This is buffr's `agents.conversations` + `agents.messages`.
- **Intent labels / routing config** — the classifier's class set and per-class routing rules (which path, which tools, escalate-by-default flags). Absent in buffr.
- **Escalation/handoff record** — `(conversation_id, reason, snapshot, assigned_human, status)`; the ticket handed to a human with full context. Absent in buffr.
- **Correction log** — `(message_id, user_thumb | human_correction, corrected_answer, created_at)`; the supervised signal that feeds KB updates or fine-tuning. Absent in buffr.

## Key components

- **Intent classifier / router** — labels each message and routes it to FAQ, RAG, an action tool, or straight to a human; choice: a cheap heuristic/keyword pass *before* any LLM call for the obvious classes, because routing every message through the model wastes latency and money on traffic a regex settles (this is the heuristic-before-LLM rule).
- **Grounded RAG answerer** — retrieves KB chunks and answers strictly from them, refusing when the KB lacks the answer; choice: an explicit grounding instruction ("ground every answer in retrieved chunks; if the KB lacks the answer, say so") rather than free generation, because an ungrounded support bot confidently invents policy and that is the worst failure mode here. **buffr already does exactly this.**
- **Confidence / escalation gate** — decides answer-vs-handoff from retrieval score, grounding, and model self-report; choice: gate on *retrieval signal* (top-k cosine score, whether any chunk cleared a threshold) not just model-reported confidence, because the model's stated confidence is uncalibrated and a low-recall retrieval is the honest "I don't know this" trigger.
- **Correction loop** — captures thumbs/edits and writes them back as new KB entries or fine-tune pairs; choice: write corrections as new *retrievable KB documents* first (cheap, immediate) before reaching for fine-tuning, because adding a corrected doc fixes the next identical question tonight while a fine-tune is a weeks-long batch with regression risk.

## Scale concerns

Ordered by what bites first:

- **Escalation routing capacity, first.** The gate's job is to protect humans. If it escalates too eagerly, humans drown; too rarely, users get wrong answers. At **>~20% escalation rate** human capacity is the bottleneck, not the model. Mitigation: tune the gate threshold against human load and track escalation precision/recall.
- **KB coverage / staleness, second.** Support KBs go stale as products change. At **any product release** answers grounded in old docs become confidently wrong. Mitigation: freshness metadata on chunks + a re-index trigger on doc change (the stale-embeddings problem from `../03-retrieval-and-rag/09-stale-embeddings.md`).
- **Conversation context growth, third.** Multi-turn support threads grow the prompt. At **>~8k tokens** of accumulated history you blow buffr's `ContextWindowGuardedProvider({ maxTokens: 8192 })` budget; you must summarize or window the transcript. Note buffr's `RagQueryAgent.answer()` treats each question independently today, so it doesn't even hit this yet — a real support bot must.
- **Correction-loop poisoning, fourth.** As correction volume rises, bad corrections enter the KB. At **any unmoderated write-back** a single wrong "fix" gets retrieved and repeated. Mitigation: review-gate corrections before they become retrievable KB docs.

## Eval framing

- **Offline, per-deploy:** answer faithfulness/groundedness (does the answer cite retrieved chunks?) and retrieval recall@k on a judged support set — buffr's `recall@3` in `src/cli/eval-cmd.ts` is the seed; faithfulness is the named gap (`[B2A.8]` in `../03-retrieval-and-rag/`).
- **Offline gate metrics:** escalation precision/recall on a labeled "should-have-escalated" set — does the gate hand off the questions a human actually needed to take?
- **Online, per-deploy:** containment rate (answered without escalation and the user didn't re-ask), CSAT/thumbs-up rate, and post-answer escalation rate (user accepted, then escalated anyway = silent failure).
- **The trap:** containment rate is gameable — a bot that confidently answers everything has 100% containment and is dangerous. Pair it with thumbs-down and post-answer escalation, never report it alone.

## Common failure modes

- **Hallucinated policy.** Probe: "user asks about a refund window you don't have a doc for — what happens?" Failure: ungrounded generation invents a policy. Mitigation: grounding prompt + refuse-when-uncovered. **buffr's grounding prompt already mitigates this.**
- **No escalation path.** Probe: "the bot can't answer — then what?" Failure: it answers anyway or dead-ends. Mitigation: a confidence gate that routes low-retrieval-signal queries to a human with full context.
- **Correction loop that never closes.** Probe: "a human corrects an answer — does the bot get it right next time?" Failure: corrections are logged and ignored. Mitigation: write corrections back as retrievable KB docs (immediate) before considering fine-tuning.
- **Intent misroute.** Probe: "a billing question hits the bug path." Failure: a single monolithic prompt fakes routing. Mitigation: an explicit classifier with measured per-class accuracy, cheap heuristic first.

## Applies to this codebase

**Partially — leaning no, by intent.** buffr is a **journaling / personal-KB Q&A tool**, not a support system. There is no customer to support, no agent to escalate to, no product whose docs go stale. So at the level of *purpose*, the answer is no. But the **answer path** maps cleanly and honestly: buffr runs RAG over a knowledge base (`RetrievalPipeline` + `search_knowledge_base` tool, `minTopK: 4` in `src/session.ts`), with the exact grounding discipline this prompt demands — "ground every answer in retrieved chunks; if the KB lacks the answer, say so." It is a bounded tool-calling agent (`RagQueryAgent`) with least-privilege tooling, retrieval-based episodic memory (`createConversationMemory`, `meta.kind='memory'`), and full trajectory capture (`SupabaseTraceSink` → `agents.messages`). That trajectory table is genuinely the substrate a correction loop would write to. What's missing is the entire control structure around the answer: **no intent classification** (every message goes to the same RAG agent), **no confidence/escalation gate** (it answers or says "not found," never hands off — there's no human to hand to), and **no feedback/correction loop** (memory is recalled, never *corrected*). The RAG-over-KB core is structurally a chatbot's answer path; the support-system scaffolding around it does not exist and, for a personal journal, mostly shouldn't.

## How to make it apply

This is largely a **thought-experiment reframe**, and you should say so in the interview: *"I built personal-KB RAG with grounding and full trajectory capture; here's how I'd extend that exact code into a support bot."* The honest framing is the strength. The concrete moves, in buffr's real files:

1. **Add intent routing in front of the agent.** Today `createChatSession().ask()` in `src/session.ts` sends every question straight to `agent.answer()`. Insert a router that classifies first — and start with a cheap heuristic pass before any model call, which ties directly to the heuristic-before-LLM file in `../01-llm-foundations/`. Obvious classes (greetings, "clear my notes") never need the agent. This is one branch added at the top of `ask()`.

2. **Add a confidence / escalation gate on retrieval signal.** The retrieval scores are already in hand — `PgVectorStore.search` returns `1 - distance` per hit (`src/pg-vector-store.ts:80`). Read the top-k score in `ask()`; if no chunk clears a threshold, return an explicit "I don't have this in your notes" instead of letting the model paper over a low-recall retrieval. In a real support deployment this same branch is the human-handoff trigger; in buffr it's an honest refusal. Either way it reuses the score buffr already computes and throws away.

3. **Add a correction-logging table.** `sql/001_agents_schema.sql` has `messages` but no place for a user's "that's wrong, it's actually X." Add a migration for `agents.corrections (message_id uuid, corrected_answer text, created_at timestamptz)`, persisted with the same `pool.query` pattern as `persistMessage` in `src/supabase-trace-sink.ts`. Then close the loop the cheap way: re-index accepted corrections as new KB documents via the existing `indexDocumentRow` path (`src/cli/index-cmd.ts`) so the next identical question retrieves the fix — no fine-tuning needed.

Defended this way: *"buffr's answer path already does grounded RAG with refuse-when-uncovered — the hard, dangerous part. The support scaffolding is three additions to real files: a heuristic-first intent router in `session.ts`, an escalation gate on the cosine score I already compute, and a corrections table that re-indexes back into the KB. The intent of buffr is personal Q&A, not support — but the bones transfer, and I can point at the line each piece bolts onto."*

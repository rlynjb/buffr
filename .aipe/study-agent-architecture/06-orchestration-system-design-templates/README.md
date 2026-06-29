# 06 — Orchestration System-Design Templates

This sub-section is different. The rest of the guide teaches buffr's concepts. This one
hands you three **interview prompts** — the kind you get whiteboarded on — and answers
each one as a system-design template, then drops buffr into it to see how much of the
template buffr already is.

Reframe: a codebase is an interview answer you already shipped. When someone says "design
a multi-agent research assistant," you don't start from a blank board — you start from the
single-agent agentic-RAG loop you built and reason *outward* to the supervisor and the
fan-out. The gap between what you have and what the prompt wants **is the design**.

## The template shape (nine bullets)

Every file here uses the same nine-bullet system-design shape — NOT the zoom-out/how-it-works
concept shape used elsewhere in the guide:

```
  ┌──────────────────────────────────────────────────────────┐
  │  SYSTEM-DESIGN TEMPLATE — nine bullets                    │
  ├──────────────────────────────────────────────────────────┤
  │  1. The prompt              the interview question         │
  │  2. Standard architecture   canonical topology + DIAGRAM   │
  │  3. Data model              registries, indices, stores    │
  │  4. Key components          per-component decisions         │
  │  5. Scale concerns          what breaks at 10x / 100x       │
  │  6. Eval framing            how you'd measure it            │
  │  7. Common failure modes    where it rots                   │
  │  8. Applies to this codebase  yes / partially / no (buffr)  │
  │  9. How to make it apply    the concrete refactor in buffr  │
  └──────────────────────────────────────────────────────────┘
```

Bullets 1–7 are the *generic* answer — true regardless of buffr. Bullets 8–9 are about
**buffr only**: an honest verdict with file anchors, and the real refactor in buffr's
actual files. All three templates appear in every guide even when the codebase doesn't
match — the not-matching is the lesson.

## What buffr is (the baseline you reason from)

A single-agent bounded ReAct loop over local Gemma2:9b. One read-only tool
(`search_knowledge_base`), capability-scoped. Agentic RAG over one source (pgvector). A
hard control envelope: 6 turns, 4 tool calls, forced synthesis. It **answers**, it does
not **act**, and there's no supervisor above it.

```
  agent loop  : /Users/rein/Public/aptkit/packages/agents/rag-query/src/rag-query-agent.ts:62-83
  envelope    : maxTurns:6 / maxToolCalls:4  (rag-query-agent.ts:75-76)
  one tool    : ragQueryToolPolicy            (rag-query-agent.ts:15-18)
  wiring      : /Users/rein/Public/buffr/src/session.ts:41-44
```

## Reading order

```
  01-multi-agent-research-assistant.md   ← buffr = ONE worker of this. PARTIALLY.
        │     "gather from many sources, synthesize"
        ▼
  02-agentic-support-system.md           ← buffr has the loop, not the ACTIONS. PARTIALLY.
        │     "take real actions across tools, escalate"
        ▼
  03-agentic-coding-system.md            ← furthest from buffr. NO.
              "read, plan, edit, verify a repo"
```

Read them in order — the verdict degrades from PARTIALLY → PARTIALLY → NO, and each file's
"how to make it apply" is a bigger refactor than the last. By the third you're describing
a different agent, which is the honest answer.

## The verdict table

| Template | Verdict for buffr | Why |
|---|---|---|
| 01 Multi-agent research assistant | **Partially** | buffr is one worker's worth: single-agent agentic RAG over one source, with citations. No supervisor, no fan-out, one source. |
| 02 Agentic support system | **Partially / No on the action half** | Has the ReAct loop + control envelope + capability scoping, but its only tool is a READ. Answers, doesn't act. No action-gating or escalation needed. |
| 03 Agentic coding system | **No** | Doesn't plan, edit, or verify. Read-only Q&A loop. The furthest template from buffr's current shape. |

# buffr — Learning-First Kernel Build Plan

**Date:** 2026-07-27
**Goal:** Replace aptkit with locally-owned kernel modules you build by hand, starting with evals so every change is measured, not guessed.

---

## Scope decision

**Migrate in place.** Pull aptkit's code into `src/kernel/` — same repo, same CLI, same Postgres, same eval harness. The current buffr IS your test harness. A new repo would mean bootstrapping everything again before you can measure anything.

```
src/
  kernel/            ← new; everything you build goes here
    types.ts         ← shared model-provider + event types
    eval-scorers.ts  ← precision@k, recall@k (first thing you build)
    rubric-judge.ts  ← faithfulness judge (wired after scorers work)
    tool-registry.ts ← registry + policy
    run-agent-loop.ts ← the main event
    memory.ts        ← episodic memory
    retrieval.ts     ← embedding provider, pipeline, chunker
    rag-agent.ts     ← wires everything together (replaces RagQueryAgent)
  session.ts         ← you edit this last to cut the aptkit import
```

When `src/kernel/` is complete and `session.ts` imports from it, delete `@rlynjb/aptkit-core` from `package.json`.

---

## The loop (reminder)

```
read the aptkit source → copy to src/kernel/ → understand every line →
change one thing by hand → run the eval → did the number move? → keep or revert
```

Never let the eval harness fall behind the code. The eval is not a formality — it is your feedback signal.

---

## Phase 0 — Evals first (the ruler)

Build the measurement harness before touching anything else. Without it you're guessing.

### 0.1 — Copy the eval scorers

**Read first:** `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`

**Create:** `src/kernel/eval-scorers.ts`

Copy the two functions verbatim, then read every line until you can explain the denominator choice for each:

```typescript
// src/kernel/eval-scorers.ts

export type RetrievalScoreResult = {
  ok: boolean;
  score: number;
  matched: number;
  total: number;
};

export function scorePrecisionAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult { /* copy from aptkit */ }

export function scoreRecallAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult { /* copy from aptkit */ }
```

**Verify you understand them:** what does `score: 0, ok: true` mean? (valid computation, zero hits — different from `ok: false` which is a bad input). What is the denominator difference between P@k and R@k?

### 0.2 — Grow the eval dataset

**File:** `eval/queries.json`

Add queries until you have 20–30 entries. Each entry needs:
- `query` — the question
- `relevantDocIds` — array of chunk document IDs that should rank in the top results
- `expectedAnswer` — the answer you expect (used by faithfulness judge in 0.3)

Run `npm run eval` after every 5 new entries to see your baseline P@1 and R@3.

### 0.3 — Wire the faithfulness eval (RubricJudge)

**Read first:** `/Users/rein/Public/aptkit/packages/evals/src/rubric-judge.ts`

The `RubricJudge` is already in aptkit; you just haven't wired it. Before copying it into `src/kernel/`, wire it as-is so you understand what it does:

**Create:** `src/cli/judge-cmd.ts`

```typescript
// src/cli/judge-cmd.ts
// Usage: node dist/src/cli/judge-cmd.js

import { RubricJudge, type RubricDefinition } from '@rlynjb/aptkit-core';
import { GemmaModelProvider } from '@rlynjb/aptkit-core';
// NOTE: don't judge with Gemma — use Claude or GPT.
// Wire a Claude provider here once you have an API key.
// For now, stub it with a console log to understand the shape.

const faithfulnessRubric: RubricDefinition = {
  id: 'faithfulness',
  title: 'RAG Faithfulness',
  task: 'Does the answer stay within the retrieved context, or does it hallucinate?',
  dimensions: [
    {
      id: 'grounding',
      label: 'Grounding',
      description: 'Every claim in the answer can be traced to the retrieved chunks.',
      scale: [
        { score: 0, description: 'Answer contains facts not in the context.' },
        { score: 1, description: 'Some facts traceable, some invented.' },
        { score: 2, description: 'All facts traceable to the context.' },
      ],
    },
  ],
  verdicts: [
    { verdict: 'pass', description: 'All dimensions score >= 1.' },
    { verdict: 'fail', description: 'Any dimension scores 0.' },
  ],
};
```

The key learning here: **the judge must not be Gemma** (you can't grade the model with itself). Wire Claude's API or stub it for now; get the RubricJudge call compiling so you understand the `judge(input)` method signature before you copy it.

### 0.4 — Add a tool-use eval

**Add to:** `eval/queries.json` (a new field on each entry)

```json
{
  "query": "what is pgvector?",
  "relevantDocIds": ["doc-abc123"],
  "expectedAnswer": "...",
  "expectedToolCall": {
    "name": "search_knowledge_base",
    "args": { "query": "pgvector vector similarity search" }
  }
}
```

**Add to:** `src/cli/eval-cmd.ts` — after scoring retrieval, check whether the agent actually called `search_knowledge_base` and whether the args contained meaningful keywords. This is what catches the silent-empty-search bug (Phase 1).

### 0.5 — Before/after runner

Add an npm script:

```json
// package.json
"scripts": {
  "eval:before": "cp eval/baseline.json eval/before.json && npm run eval -- --output eval/before.json",
  "eval:diff": "node dist/src/cli/eval-diff.js eval/before.json eval/after.json"
}
```

Create `eval/baseline.json` once you have a stable baseline. Every change you make: run `npm run eval`, compare to baseline. If the number dropped, revert. If it rose, commit.

---

## Phase 1 — Fix the two known bugs (eval-gated)

Do these after Phase 0 because Phase 0 gives you the ruler. Don't fix blindly.

### 1.1 — Tool-arg validation (the silent empty-search bug)

**The bug:** Gemma emits tool calls with keys that don't match the schema (`query` vs `input`, etc). The tool-call dispatcher gets the wrong key, the search runs with `undefined`, returns zero results, the agent answers "I don't know" — silently. No error, no trace.

**How to see it:** Look at `agents.messages` for rows where `role = 'tool_call'` and the args are `{}` or mismatched keys.

**Read first:** `/Users/rein/Public/aptkit/packages/runtime/src/run-agent-loop.ts` lines 100–140 (the tool-dispatch block). Look at how `toolUse.input` is passed to `callTool`.

**Fix:** Add a validation step before `callTool` in `session.ts` or in a thin wrapper around `InMemoryToolRegistry`. Check that the required args key (`query`) is present and non-empty. If not, return an error result instead of calling the tool — the agent loop will see the error and may self-correct.

**Gate:** Run `npm run eval` before and after. The tool-use eval (0.4) should show `expectedToolCall` match rate rising.

### 1.2 — Test `session.ts`

**Create:** `test/session.test.ts`

You can't safely refactor the agent loop without tests on the wiring. Write integration-style tests that use a fake model provider returning canned responses, so you test the full `ask()` flow without hitting Ollama:

```typescript
// test/session.test.ts
import { describe, it, expect } from 'vitest';

// A stub model provider that returns a fixed tool call then a fixed answer
class StubModel {
  id = 'stub';
  async complete() {
    return { content: [{ type: 'text', text: 'the answer is 42' }] };
  }
}

describe('ChatSession', () => {
  it('returns the model response as the answer', async () => {
    // wire a session with the stub model
    // call ask('what is 42?')
    // assert the answer contains '42'
  });
});
```

Run `npm test` after every edit in Phase 2. These tests are your regression net.

---

## Phase 2 — Copy and own the agent loop

This is the main event. You build `src/kernel/run-agent-loop.ts` by hand, not by `cp`.

### 2.0 — Read the original first

**Read:** `/Users/rein/Public/aptkit/packages/runtime/src/run-agent-loop.ts` (228 lines)

Before writing a single line of your own, answer these questions from the source:

1. What is the structure of the `messages` array at the start of each turn? (hint: it grows — `messages.push()` twice per turn)
2. When does the loop exit without using a tool? (hint: `toolUses.length === 0`)
3. What is `forceFinal` and what does it do? (hint: removes `toolSchemas` from the last turn)
4. What is `synthesisInstruction` for? (hint: tells the model "no more tool calls available, synthesize now")
5. What is the recovery turn? (hint: structured output repair — fires only when `parseResult` returns null)

### 2.1 — Copy the types

**Create:** `src/kernel/types.ts`

Copy from `/Users/rein/Public/aptkit/packages/runtime/src/model-provider.ts` verbatim:

```typescript
// src/kernel/types.ts

export type ModelTextBlock = { type: 'text'; text: string };
export type ModelToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ModelToolResultBlock = { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock;
export type ModelMessage = { role: 'user' | 'assistant'; content: string | ModelContentBlock[] | ModelToolResultBlock[] };
export type ModelTool = { name: string; description?: string; inputSchema: object };
export type ModelUsage = { inputTokens?: number; outputTokens?: number; estimated?: boolean };
export type ModelRequest = { system?: string; messages: ModelMessage[]; tools?: ModelTool[]; maxTokens?: number; temperature?: number; signal?: AbortSignal };
export type ModelResponse = { content: ModelContentBlock[]; usage?: ModelUsage; model?: string };
export type ModelProvider = { id: string; defaultModel?: string; complete(request: ModelRequest): Promise<ModelResponse> };

// Events (from aptkit/runtime/src/events.ts — copy the CapabilityEvent union and CapabilityTraceSink)
export type CapabilityEvent = /* ... copy the union ... */;
export type CapabilityTraceSink = { emit(event: CapabilityEvent): void };
```

**Check:** `src/supabase-trace-sink.ts` implements `CapabilityTraceSink` already. Once you have `src/kernel/types.ts`, update its import to point there.

### 2.2 — Write the agent loop from the read

**Create:** `src/kernel/run-agent-loop.ts`

Write it from your understanding of 2.0, not copy-paste. Check against the original when stuck. Your goal is to produce the same loop shape but understand every line:

```typescript
// src/kernel/run-agent-loop.ts

export type RunAgentLoopOptions<T = null> = {
  capabilityId: string;
  model: ModelProvider;
  tools: ToolExecutor;
  system: string;
  userPrompt: string;
  toolSchemas: ModelTool[];
  trace?: CapabilityTraceSink;
  maxTurns?: number;
  maxTokens?: number;
  synthesisInstruction?: string;
  signal?: AbortSignal;
  parseResult?: (finalText: string) => T | null;
};

export async function runAgentLoop<T = null>(
  options: RunAgentLoopOptions<T>,
): Promise<{ finalText: string; toolCalls: ToolCallRecord[]; parsed: T | null }> {
  // your implementation here
}
```

**The first extension to add (after baseline passes eval):** conversation history threading. Today each call to `session.ask()` creates a fresh `messages` array with just the new question. Add a `history: ModelMessage[]` parameter so prior turns can be threaded in. This is the single biggest "feels smarter" improvement. Gate it: P@1 should not drop.

### 2.3 — Tool-call repair

Add a retry step inside the loop: if a tool call fails with a key-mismatch error (the bug from Phase 1), send one corrective nudge before counting it as failed:

```typescript
// inside runAgentLoop, after catching a tool error:
if (isArgMismatch(error)) {
  // push a user message explaining the correct key, let the model retry
  messages.push({ role: 'user', content: toolResults }); // error result included
  // next loop iteration will re-call with hopefully corrected args
  continue;
}
```

Gate: tool-use eval match rate should rise.

---

## Phase 3 — Copy the tool registry

**Read first:** `/Users/rein/Public/aptkit/packages/tools/src/tool-registry.ts`

**Create:** `src/kernel/tool-registry.ts`

The registry is ~65 lines. Copy and understand:

```typescript
// src/kernel/tool-registry.ts

export type ToolDefinition = ModelTool;

export type ToolHandler = (
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export type ToolExecutor = {
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ result: unknown; durationMs: number }>;
};

export class InMemoryToolRegistry implements ToolExecutor {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  schemas(): ModelTool[] {
    return [...this.tools.values()].map(t => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ result: unknown; durationMs: number }> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    const start = performance.now();
    const result = await tool.handler(args, opts);
    return { result, durationMs: performance.now() - start };
  }
}
```

---

## Phase 4 — Copy conversation memory

**Read first:** `/Users/rein/Public/aptkit/packages/memory/src/conversation-memory.ts` (the key learning: why `recall` over-fetches with `k*4` then filters by `kind`)

**Create:** `src/kernel/memory.ts`

Copy verbatim, understand the dimension-mismatch guard at the top, understand the `counters` Map for unique IDs, understand why recall over-fetches.

---

## Phase 5 — Copy the retrieval pipeline

**Read first:**
- `/Users/rein/Public/aptkit/packages/retrieval/src/` — all files (embedding provider, pipeline, chunker)

**Create:** `src/kernel/retrieval.ts`

The retrieval module has three concerns:
1. `EmbeddingProvider` — calls Ollama's `/api/embeddings` endpoint
2. `Chunker` — splits text into overlapping chunks
3. `createRetrievalPipeline` — wires embedder + vector store into `index(text)` and `search(query, k)`

Build them in that order. The chunker is pure (no I/O) — test it in isolation with vitest.

---

## Phase 6 — Wire a local RagQueryAgent and cut the import

**Create:** `src/kernel/rag-agent.ts`

This replaces `RagQueryAgent` from `@aptkit/agents/rag-query`. It wires:

```typescript
// src/kernel/rag-agent.ts
import { runAgentLoop } from './run-agent-loop.js';
import { InMemoryToolRegistry } from './tool-registry.js';
import type { ConversationMemory } from './memory.js';
import type { RetrievalPipeline } from './retrieval.js';
import type { ModelProvider } from './types.js';

export type RagAgentOptions = {
  model: ModelProvider;
  retrieval: RetrievalPipeline;
  memory: ConversationMemory;
  profile: string;
  capabilityId: string;
  trace?: CapabilityTraceSink;
};

export async function askRagAgent(question: string, opts: RagAgentOptions): Promise<string> {
  const registry = new InMemoryToolRegistry();

  registry.register(
    { name: 'search_knowledge_base', description: 'Search indexed documents.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    async (args) => {
      const query = args['query'] as string;
      return opts.retrieval.search(query, 4);
    },
  );

  const { finalText } = await runAgentLoop({
    capabilityId: opts.capabilityId,
    model: opts.model,
    tools: registry,
    system: opts.profile || 'You are a helpful assistant.',
    userPrompt: question,
    toolSchemas: registry.schemas(),
    trace: opts.trace,
  });

  return finalText;
}
```

**Last step:** edit `src/session.ts` to import from `./kernel/` instead of `@rlynjb/aptkit-core`, then remove `@rlynjb/aptkit-core` from `package.json`.

Run `npm run eval` one final time. Your P@1 and R@3 should match or exceed the baseline from Phase 0.

---

## Build order summary

| Phase | What you build | File | Lines to write | Eval gate |
|-------|---------------|------|----------------|-----------|
| 0.1 | Eval scorers | `src/kernel/eval-scorers.ts` | ~50 | P@1 and R@3 now have a number |
| 0.2 | Grow dataset | `eval/queries.json` | ~25 entries | baseline score established |
| 0.3 | Faithfulness judge | wire RubricJudge in `eval-cmd.ts` | ~30 | faithfulness score exists |
| 0.4 | Tool-use eval | add to `eval-cmd.ts` | ~20 | tool-call match rate measured |
| 1.1 | Tool-arg fix | edit `session.ts` wrapper | ~15 | tool-call match rate rises |
| 1.2 | Session tests | `test/session.test.ts` | ~50 | `npm test` green |
| 2.1 | Kernel types | `src/kernel/types.ts` | ~40 | TypeScript compiles |
| 2.2 | Agent loop | `src/kernel/run-agent-loop.ts` | ~180 | P@1 / R@3 unchanged |
| 2.3 | History threading | extend run-agent-loop | ~20 | P@1 unchanged, "smarter" chat |
| 3 | Tool registry | `src/kernel/tool-registry.ts` | ~50 | compiles, tests pass |
| 4 | Memory | `src/kernel/memory.ts` | ~80 | compiles, tests pass |
| 5 | Retrieval | `src/kernel/retrieval.ts` | ~200 | P@1 / R@3 unchanged |
| 6 | Rag agent + cut | `src/kernel/rag-agent.ts` + `session.ts` | ~50 | P@1 / R@3 match baseline |

Total: ~795 lines. Every line is code you read and understood before writing.

---

## What NOT to let AI build

| Build by hand (to learn it) | AI can help with |
|-----------------------------|-----------------|
| `run-agent-loop.ts` | vitest test scaffolding |
| `eval-scorers.ts` | migrations, boilerplate |
| The faithfulness rubric definition | a new VectorStore adapter (once you know the pattern) |
| The conversation history threading | the 3rd and 4th tools |
| The chunker | the eval dataset entries (you write the queries; AI can suggest relevant doc IDs) |

Rule: never let AI build the thing you're currently trying to understand. Let it build the neighbors of what you've already learned.

---

## Connection to the DI platform

The `Capability<TInput, TOutput>` interface in `docs/buffr-decision-intelligence-implementation-plan.md` maps directly to what `askRagAgent` becomes at Phase 6:

```typescript
// the DI platform's interface
interface Capability<TInput, TOutput> {
  name: string;
  version: string;
  execute(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}

// askRagAgent as a Capability:
// TInput = { question: string }
// TOutput = string
// AgentContext holds the model, retrieval, memory, trace
```

Once Phase 6 is done and you own the agent loop, wrapping it in the `Capability` interface is a one-afternoon step. The DI platform is built on top of the kernel you built here — not a separate thing you start from scratch.

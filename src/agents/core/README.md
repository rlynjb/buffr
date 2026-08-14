# M0 Core Policy

## Purpose

M0 defines shared policy and runtime guidance for M1-M7. It keeps evidence labels, credential boundaries, structured output rules, and Etsy mutation constraints consistent across modules.

## When It Runs

M0 is not a workflow turn. The deterministic workflow engine never routes to M0. Module wrappers prepend this policy to module-specific prompts before asking a runner for structured output.

## Input Contract

M0 does not consume workflow evidence directly. Runtime helpers accept a `ModuleId` from `src/contracts/modules.ts` and a co-located module prompt string.

## Output Contract

`policy.ts` exports `M0_POLICY`, `M3_DEFAULT_LIMITS`, and `buildModuleInstructions`. Module outputs still use the shared schemas in `src/contracts/`; this README intentionally does not duplicate those schemas.

## Dependencies

- `policy.md` is the co-located Markdown source of truth.
- `policy.ts` loads the Markdown policy for runtime use.
- Shared contract types live in `src/contracts/`.

## Permitted Tools

None directly. M0 defines boundaries for modules but does not call Etsy, web search, OpenAI, files, or other tools.

## Success, Stop, Pause, And Failure Conditions

- Success: every module receives the same shared policy before its role-specific prompt.
- Stop: M0 never decides workflow stop conditions; the deterministic engine does.
- Pause: M0 never pauses a workflow; modules use structured output and engine gates.
- Failure: missing or unreadable `policy.md` is a startup/configuration problem and should fail loudly during tests or runtime initialization.

## Related Documents

- `docs/superpowers/specs/2026-08-12-etsy-workflow-engine-design.md`
- `docs/superpowers/plans/2026-08-12-etsy-workflow-engine.md`
- `src/contracts/modules.ts`
*** Add File: /Users/rein/Public/buffr/src/agents/runner.ts
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import type { ModuleId } from '../contracts/modules.js';
import { parseWithSchema } from '../contracts/workflow.js';
import { buildModuleInstructions } from './core/policy.js';

export type TraceContext = {
  runId: string;
  stage?: string;
  parentTraceId?: string;
};

export type AgentRunInput<TOutput> = {
  moduleId: ModuleId;
  instructions: string;
  input: unknown;
  outputSchema: z.ZodType<TOutput>;
  trace: TraceContext;
};

export type AgentRunResult<TOutput> = {
  output: TOutput;
  traceId?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
};

export type AgentRunner = {
  runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>>;
};

export type RunStructuredModuleInput<TOutput> = {
  runner: AgentRunner;
  moduleId: ModuleId;
  modulePrompt: string;
  input: unknown;
  outputSchema: z.ZodType<TOutput>;
  trace: TraceContext;
};

export type StructuredModuleRunResult<TOutput> = AgentRunResult<TOutput> & {
  instructions: string;
};

export class FakeAgentRunner implements AgentRunner {
  constructor(
    private readonly outputs: Partial<Record<ModuleId, unknown>>,
    private readonly options: { failWith?: Error } = {},
  ) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    if (this.options.failWith) {
      throw this.options.failWith;
    }

    return {
      output: parseWithSchema(input.outputSchema, this.outputs[input.moduleId], `${input.moduleId} output`),
    };
  }
}

export class OpenAiAgentRunner implements AgentRunner {
  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    void input;
    throw new AppError('connector_failed', 'OpenAiAgentRunner is not wired for real model calls yet');
  }
}

export async function runStructuredModule<TOutput>(
  input: RunStructuredModuleInput<TOutput>,
): Promise<StructuredModuleRunResult<TOutput>> {
  const instructions = buildModuleInstructions(input.moduleId, input.modulePrompt);

  try {
    const result = await input.runner.runStructured({
      moduleId: input.moduleId,
      instructions,
      input: input.input,
      outputSchema: input.outputSchema,
      trace: input.trace,
    });

    return {
      ...result,
      instructions,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('connector_failed', `${input.moduleId} runner failed`, { cause: error });
  }
}

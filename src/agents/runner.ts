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

    void error;
    throw new AppError('connector_failed', `${input.moduleId} runner failed`);
  }
}

import { z } from 'zod';
import { Agent, run, setDefaultOpenAIKey } from '@openai/agents';
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

export type OpenAiAgentRunnerOptions = {
  apiKey?: string;
  model?: string;
  execute?: (input: { instructions: string; input: unknown }) => Promise<unknown>;
};

/** Production adapter for the AgentRunner port; tests inject execute and never call the network. */
export class OpenAiAgentRunner implements AgentRunner {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly execute: OpenAiAgentRunnerOptions['execute'];

  constructor(options: OpenAiAgentRunnerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-5.4';
    this.execute = options.execute;
  }

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    if (!this.apiKey) {
      throw new AppError('configuration_failed', 'Missing required OpenAI configuration: OPENAI_API_KEY');
    }

    try {
      const output = this.execute
        ? await this.execute({ instructions: input.instructions, input: input.input })
        : await this.runWithSdk(input);
      return {
        output: parseWithSchema(input.outputSchema, output, `${input.moduleId} output`),
        model: this.model,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('connector_failed', `${input.moduleId} OpenAI runner failed`);
    }
  }

  private async runWithSdk<TOutput>(input: AgentRunInput<TOutput>): Promise<unknown> {
    setDefaultOpenAIKey(this.apiKey!);
    const agent = new Agent<any, any>({
      name: `Buffr ${input.moduleId}`,
      model: this.model,
      instructions: input.instructions,
      outputType: input.outputSchema as any,
    });
    const result = await run(agent, JSON.stringify(input.input));
    if (result.finalOutput === undefined) {
      throw new AppError('connector_failed', `${input.moduleId} OpenAI runner returned no structured output`);
    }
    return result.finalOutput;
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
      input: sanitizeModuleInput(input.input),
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

const CREDENTIAL_KEY_PATTERN = /api[_-]?key|secret|token|refresh/i;

export function sanitizeModuleInput(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModuleInput(item));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !CREDENTIAL_KEY_PATTERN.test(key))
      .map(([key, child]) => [key, sanitizeModuleInput(child)]),
  );
}

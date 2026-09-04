import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { webSearchTool } from '@openai/agents';
import { AppError } from '../../core/errors.js';
import { buildModuleInstructions } from '../../agents/core/policy.js';
import { FakeAgentRunner, OpenAiAgentRunner, runStructuredModule, toOpenAiStructuredOutputSchema } from '../../agents/runner.js';
import {
  ContextOutputSchema,
  DiagnosisOutputSchema,
  EvaluationOutputSchema,
  HypothesisOutputSchema,
  MetricsOutputSchema,
  ResearchOutputSchema,
  TestPlanOutputSchema,
} from '../../contracts/modules.js';

const OutputSchema = z
  .object({
    summary: z.string().min(1),
    confidence: z.enum(['low', 'moderate', 'high']),
  })
  .strict();

describe('agent runner seam', () => {
  it('validates valid structured output with the supplied Zod schema', async () => {
    const runner = new FakeAgentRunner({
      m4: { summary: 'Title likely mismatches buyer wording.', confidence: 'moderate' },
    });

    const result = await runStructuredModule({
      runner,
      moduleId: 'm4',
      modulePrompt: 'M4 Diagnosis: identify one bottleneck.',
      input: { listingId: 'listing-123' },
      outputSchema: OutputSchema,
      trace: { runId: 'run-123', stage: 'm4_diagnosis' },
    });

    expect(result.output).toEqual({
      summary: 'Title likely mismatches buyer wording.',
      confidence: 'moderate',
    });
    expect(result.instructions).toBe(buildModuleInstructions('m4', 'M4 Diagnosis: identify one bottleneck.'));
  });

  it('rejects malformed structured output with a clear validation AppError', async () => {
    const runner = new FakeAgentRunner({
      m4: { summary: '', confidence: 'certain' },
    });

    await expect(
      runStructuredModule({
        runner,
        moduleId: 'm4',
        modulePrompt: 'M4 Diagnosis',
        input: {},
        outputSchema: OutputSchema,
        trace: { runId: 'run-123' },
      }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'validation_failed',
      message: 'm4 output failed validation',
    } satisfies Partial<AppError>);
  });

  it('wraps runner failures as connector AppErrors without retaining credential-bearing causes', async () => {
    const runner = new FakeAgentRunner(
      {},
      {
        failWith: new Error('OPENAI_API_KEY=secret-value request failed'),
      },
    );

    try {
      await runStructuredModule({
        runner,
        moduleId: 'm4',
        modulePrompt: 'M4 Diagnosis',
        input: {},
        outputSchema: OutputSchema,
        trace: { runId: 'run-123' },
      });
      throw new Error('Expected runner failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'AppError',
        code: 'connector_failed',
        message: 'm4 runner failed',
      } satisfies Partial<AppError>);
      expect((error as AppError).cause).toBeUndefined();
    }
  });

  it('uses a configured OpenAI runner through the same structured-output port', async () => {
    const calls: Array<{ instructions: string; input: unknown }> = [];
    const runner = new OpenAiAgentRunner({
      apiKey: 'test-key',
      model: 'gpt-5.4',
      execute: async (input) => {
        calls.push(input);
        return { output: { summary: 'The weekly evidence is qualified.', confidence: 'high' } };
      },
    });

    const result = await runner.runStructured({
      moduleId: 'm4',
      instructions: 'Return only the requested structured output.',
      input: { product: 'MerchGrid' },
      outputSchema: OutputSchema,
      trace: { runId: 'run-123', stage: 'm4_diagnosis' },
    });

    expect(result).toMatchObject({
      output: { summary: 'The weekly evidence is qualified.', confidence: 'high' },
      model: 'gpt-5.4',
    });
    expect(calls).toEqual([{ instructions: 'Return only the requested structured output.', input: { product: 'MerchGrid' } }]);
  });

  it('passes optional hosted tools and model through the structured runner seam', async () => {
    const hostedTools = [webSearchTool({ searchContextSize: 'low' })];
    const calls: Array<{
      hostedTools?: readonly ReturnType<typeof webSearchTool>[];
      model?: string;
    }> = [];
    const runner = new OpenAiAgentRunner({
      apiKey: 'test-key',
      execute: async (input) => {
        calls.push(input);
        return {
          output: { summary: 'The official source answered the question.', confidence: 'low' },
          usage: { totalTokens: 15 },
        };
      },
    });

    const result = await runStructuredModule({
      runner,
      moduleId: 'm3',
      modulePrompt: 'Lookup official documentation.',
      input: {},
      outputSchema: OutputSchema,
      trace: { runId: 'run-123' },
      hostedTools,
      model: 'test-research-model',
    });

    expect(calls[0]?.hostedTools).toBe(hostedTools);
    expect(calls[0]?.model).toBe('test-research-model');
    expect(result.usage).toEqual({ totalTokens: 15 });
  });

  it('normalizes SDK nulls for optional research provenance before persistence', async () => {
    const runner = new OpenAiAgentRunner({
      apiKey: 'test-key',
      execute: async () => ({
        output: {
          status: 'resolved',
          next_action: 'stop',
          requester: 'm4',
          question: 'Synthetic policy question',
          evidence: [
            {
              source: 'web',
              title: 'Official guide',
              url: 'https://docs.example.test/guide',
              excerpt: 'Synthetic guidance.',
              fetchedAt: '2026-08-31T00:00:00.000Z',
              domain: null,
              sourceType: null,
              retrievalMethod: null,
              searchPass: null,
            },
          ],
          confidence: 'low',
          limitations: [],
          searchSummaries: null,
          requestedLookup: null,
        },
      }),
    });

    const result = await runner.runStructured({
      moduleId: 'm3',
      instructions: 'Return structured output.',
      input: {},
      outputSchema: ResearchOutputSchema,
      trace: { runId: 'run-123' },
    });

    expect(result.output.searchSummaries).toBeUndefined();
    expect(result.output.evidence[0]).toMatchObject({
      source: 'web',
      domain: undefined,
      sourceType: undefined,
      retrievalMethod: undefined,
      searchPass: undefined,
    });
  });

  it('rejects an OpenAI runner without a configured API key before any model call', async () => {
    const runner = new OpenAiAgentRunner({ apiKey: '' });

    await expect(
      runner.runStructured({
        moduleId: 'm4',
        instructions: 'Return structured output.',
        input: {},
        outputSchema: OutputSchema,
        trace: { runId: 'run-123' },
      }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'configuration_failed',
      message: 'Missing required OpenAI configuration: OPENAI_API_KEY',
    } satisfies Partial<AppError>);
  });

  it('converts agent output schemas to OpenAI-compatible structured-output schemas', () => {
    const schemas = {
      ContextOutputSchema,
      DiagnosisOutputSchema,
      EvaluationOutputSchema,
      HypothesisOutputSchema,
      MetricsOutputSchema,
      ResearchOutputSchema,
      TestPlanOutputSchema,
    };

    const optionalPaths = Object.entries(schemas).flatMap(([name, schema]) =>
      findOptionalZodFields(toOpenAiStructuredOutputSchema(schema as z.ZodTypeAny), name),
    );

    expect(optionalPaths).toEqual([]);
  });
});

function findOptionalZodFields(schema: z.ZodTypeAny, path: string): string[] {
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodOptional) return [path];
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    return findOptionalZodFields(schema._def.innerType, path);
  }
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodArray) {
    return findOptionalZodFields(schema._def.type, `${path}[]`);
  }
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    return Object.entries((schema as z.ZodObject<z.ZodRawShape>).shape).flatMap(([key, child]) =>
      findOptionalZodFields(child as z.ZodTypeAny, `${path}.${key}`),
    );
  }
  if (schema._def.typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
    return findOptionalZodFields(schema._def.schema, path);
  }
  return [];
}

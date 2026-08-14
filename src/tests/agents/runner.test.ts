import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { buildModuleInstructions } from '../../agents/core/policy.js';
import { FakeAgentRunner, runStructuredModule } from '../../agents/runner.js';

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
});

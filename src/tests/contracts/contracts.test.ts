import { describe, expect, it } from 'vitest';
import { NormalizedListingEvidenceSchema } from '../../contracts/evidence.js';
import { ResearchOutputSchema } from '../../contracts/modules.js';
import { parseWithSchema, WorkflowRunStateSchema } from '../../contracts/workflow.js';
import { makeFixtureListingEvidence } from '../fixtures/listing.js';

describe('contracts', () => {
  it('accepts normalized Etsy evidence and rejects raw credentials', () => {
    const evidence = makeFixtureListingEvidence();
    expect(NormalizedListingEvidenceSchema.parse(evidence).listingId).toBe('listing-123');

    expect(() =>
      NormalizedListingEvidenceSchema.parse({ ...evidence, apiKey: 'secret-value' }),
    ).toThrow();
  });

  it('normalizes M3 status and next_action values', () => {
    const result = ResearchOutputSchema.parse({
      status: 'partly_resolved',
      next_action: 'stop',
      requester: 'm5',
      question: 'What test duration is defensible for low-volume listings?',
      evidence: [
        {
          source: 'web',
          title: 'Etsy help',
          url: 'https://example.com/etsy',
          excerpt: 'Use listing stats.',
          fetchedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
      confidence: 'moderate',
      limitations: ['Example citation only for contract shape.'],
    });

    expect(result.status).toBe('partly_resolved');
    expect(() => ResearchOutputSchema.parse({ ...result, status: 'blocked' })).toThrow();
    expect(() => ResearchOutputSchema.parse({ ...result, next_action: 'blocked' })).toThrow();
    expect(() => ResearchOutputSchema.parse({ ...result, next_action: 'continue' })).toThrow();
    expect(
      ResearchOutputSchema.parse({
        ...result,
        next_action: 'continue',
        requestedLookup: {
          tool: 'hosted_web_search',
          reason: 'Need a cited source for low-volume Etsy experiment duration.',
          input: { query: 'Etsy low volume listing experiment duration' },
        },
      }).requestedLookup?.tool,
    ).toBe('hosted_web_search');
  });

  it('validates persisted run state shape', () => {
    const state = WorkflowRunStateSchema.parse({
      runId: 'run-123',
      listingId: 'listing-123',
      status: 'analyzing',
      stage: 'm1_context',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      evidenceRefs: [],
      moduleOutputs: {},
      events: [],
    });

    expect(state.stage).toBe('m1_context');
  });

  it('returns parsed schema defaults from the shared parser helper', () => {
    const result = parseWithSchema(
      ResearchOutputSchema,
      {
        status: 'resolved',
        next_action: 'continue',
        requester: 'm5',
        question: 'What wording do buyers use?',
        evidence: [],
        confidence: 'moderate',
        limitations: [],
        requestedLookup: {
          tool: 'hosted_web_search',
          reason: 'Need a citation',
        },
      },
      'research output',
    );

    expect(result.requestedLookup?.input).toEqual({});
  });
});

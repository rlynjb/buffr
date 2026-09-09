import { describe, expect, it } from 'vitest';
import { NormalizedListingEvidenceSchema } from '../../contracts/evidence.js';
import {
  ExperimentApplicationSchema,
  PriorLearningContextSchema,
} from '../../contracts/marketplace-visibility.js';
import { ResearchOutputSchema, ResearchSearchSummarySchema } from '../../contracts/modules.js';
import {
  parseWithSchema,
  WorkflowRunStateSchema,
} from '../../contracts/workflow.js';
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

  it('keeps historical research outputs compatible and accepts bounded search provenance', () => {
    const historical = {
      status: 'resolved',
      next_action: 'stop',
      requester: 'm4',
      question: 'Synthetic question',
      evidence: [],
      confidence: 'low',
      limitations: [],
    } as const;

    expect(ResearchOutputSchema.parse(historical)).not.toHaveProperty('searchSummaries');

    const withProvenance = {
      ...historical,
      evidence: [
        {
          source: 'web',
          title: 'Official guide',
          url: 'https://docs.example.test/official-guide',
          excerpt: 'Synthetic documentation excerpt.',
          fetchedAt: '2026-08-31T00:00:00.000Z',
          domain: 'docs.example.test',
          sourceType: 'official_platform',
          retrievalMethod: 'openai_hosted_web_search',
          searchPass: 'authoritative_domains',
        },
      ],
      searchSummaries: [
        {
          pass: 'authoritative_domains',
          status: 'completed',
          citationCount: 1,
          officialCitationCount: 1,
          broaderCitationCount: 0,
          allowedDomainCount: 3,
          startedAt: '2026-08-31T00:00:00.000Z',
          completedAt: '2026-08-31T00:00:01.000Z',
        },
      ],
    } as const;

    expect(ResearchOutputSchema.parse(withProvenance)).toMatchObject({
      searchSummaries: [{ pass: 'authoritative_domains', citationCount: 1 }],
    });
    expect(() => ResearchOutputSchema.parse({ ...withProvenance, rawHtml: '<html />' })).toThrow();
  });

  it('normalizes provider nulls in optional search-summary fields', () => {
    const summary = ResearchSearchSummarySchema.parse({
      pass: 'authoritative_domains',
      status: 'completed',
      citationCount: 1,
      officialCitationCount: 1,
      broaderCitationCount: 0,
      allowedDomainCount: 2,
      failureCategory: null,
      totalTokens: null,
      estimatedCostUsd: null,
      startedAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:00:01.000Z',
    });

    expect(summary).toMatchObject({
      failureCategory: undefined,
      totalTokens: undefined,
      estimatedCostUsd: undefined,
    });
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
    expect(state).not.toHaveProperty('marketplaceIdentity');
  });

  it('keeps applied and not-applied experiment facts mutually exclusive', () => {
    expect(ExperimentApplicationSchema.parse({
      status: 'applied',
      appliedAt: '2026-09-01',
    })).toEqual({
      status: 'applied',
      appliedAt: '2026-09-01',
    });
    expect(ExperimentApplicationSchema.parse({
      status: 'not_applied',
      decidedAt: '2026-09-01T12:00:00.000Z',
    })).toEqual({
      status: 'not_applied',
      decidedAt: '2026-09-01T12:00:00.000Z',
    });
    expect(() => ExperimentApplicationSchema.parse({
      status: 'applied',
      appliedAt: '2026-09-01',
      decidedAt: '2026-09-01T12:00:00.000Z',
    })).toThrow();
  });

  it('persists optional rolling identity, application, and bounded learning fields', () => {
    const state = WorkflowRunStateSchema.parse({
      runId: 'marketplace-2026-09-08',
      marketplaceIdentity: {
        profile: 'merchgrid_shopify_app_store',
        productRef: 'merchgrid-shopify-app',
      },
      experimentApplication: {
        status: 'not_applied',
        decidedAt: '2026-09-08T12:00:00.000Z',
      },
      previousRunRef: 'marketplace-2026-09-01',
      priorLearning: {
        sourceRunId: 'marketplace-2026-09-01',
        sourceEvidenceRef: 'artifacts/merchgrid/weekly/2026-09-01.json',
        experimentPlanRef: 'artifacts/workflow-runs/marketplace-2026-09-01/experiment-plan.json',
        outcome: 'inconclusive',
        hypothesisEvaluation: 'partly_supported',
        learning: 'The baseline signal was too sparse for a confident decision',
        confidence: 'low',
        nextAction: 'iterate',
        nextActionRationale: 'Use clearer outcome language in the next listing revision',
      },
      status: 'analyzing',
      stage: 'm1_context',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
      evidenceRefs: [],
      moduleOutputs: {},
      events: [],
    });

    expect(state).toMatchObject({
      marketplaceIdentity: { productRef: 'merchgrid-shopify-app' },
      experimentApplication: { status: 'not_applied' },
      previousRunRef: 'marketplace-2026-09-01',
      priorLearning: { outcome: 'inconclusive' },
    });
  });

  it('accepts only the bounded M7 learning projection and local provenance references', () => {
    const priorLearning = {
      sourceRunId: 'marketplace-2026-09-01',
      sourceEvidenceRef: 'artifacts/merchgrid/weekly/2026-09-01.json',
      experimentPlanRef: 'artifacts/workflow-runs/marketplace-2026-08-25/experiment-plan.json',
      outcome: 'inconclusive',
      hypothesisEvaluation: 'partly_supported',
      learning: 'The baseline signal was too sparse for a confident decision',
      confidence: 'low',
      nextAction: 'iterate',
      nextActionRationale: 'Use clearer outcome language in the next listing revision',
    } as const;

    expect(PriorLearningContextSchema.parse(priorLearning)).toEqual(priorLearning);
    expect(() => PriorLearningContextSchema.parse({
      ...priorLearning,
      rawProviderPayload: { token: 'secret' },
    })).toThrow();
  });

  it.each(['learning', 'nextActionRationale'] as const)(
    'caps prior-learning %s at 1000 characters',
    (field) => {
      const priorLearning = {
        sourceRunId: 'marketplace-2026-09-01',
        sourceEvidenceRef: 'artifacts/merchgrid/weekly/2026-09-01.json',
        experimentPlanRef: 'artifacts/workflow-runs/marketplace-2026-08-25/experiment-plan.json',
        outcome: 'inconclusive',
        hypothesisEvaluation: 'partly_supported',
        learning: 'A',
        confidence: 'low',
        nextAction: 'iterate',
        nextActionRationale: 'B',
        [field]: 'x'.repeat(1_000),
      } as const;

      expect(PriorLearningContextSchema.parse(priorLearning)[field]).toHaveLength(1_000);
      expect(() => PriorLearningContextSchema.parse({
        ...priorLearning,
        [field]: 'x'.repeat(1_001),
      })).toThrow();
    },
  );

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

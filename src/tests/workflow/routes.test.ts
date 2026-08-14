import { describe, expect, it } from 'vitest';
import type {
  DiagnosisOutput,
  EvaluationOutput,
  HypothesisOutput,
  MetricsOutput,
  TestPlanOutput,
} from '../../contracts/modules.js';
import {
  routeAfterM2Initial,
  routeAfterM2Results,
  routeAfterM4,
  routeAfterM5,
  routeAfterM6,
  routeAfterM7,
} from '../../workflow/routes.js';

describe('workflow routes', () => {
  it('routes M2 initial to diagnosis when evidence is sufficient', () => {
    expect(routeAfterM2Initial(metricsOutput())).toEqual({
      type: 'advance',
      nextStage: 'm4_diagnosis',
    });
  });

  it('routes M2 initial to bounded research when a research need exists', () => {
    expect(routeAfterM2Initial(metricsOutput({ researchNeed: 'Check category seasonality' }))).toEqual({
      type: 'research',
      requester: 'm2',
      returnStage: 'm2_metrics_initial',
      question: 'Check category seasonality',
    });
  });

  it('waits for data when M2 initial evidence is missing', () => {
    expect(
      routeAfterM2Initial(
        metricsOutput({
          comparisonQuality: 'missing',
          metrics: [
            {
              name: 'conversion_rate',
              current: null,
              baseline: null,
              absoluteChange: null,
              percentageChange: null,
              qualification: 'not_available',
              confidence: 'low',
            },
          ],
        }),
      ),
    ).toEqual({ type: 'wait', reason: 'metrics evidence is missing' });
  });

  it('maps M4 decisions to deterministic next steps', () => {
    expect(routeAfterM4(diagnosisOutput({ decision: 'proceed_to_hypothesis' }))).toEqual({
      type: 'advance',
      nextStage: 'm5_hypothesis',
    });
    expect(
      routeAfterM4(
        diagnosisOutput({
          decision: 'research_domain_knowledge',
          researchQuestion: 'What customer language is common for this niche?',
        }),
      ),
    ).toEqual({
      type: 'research',
      requester: 'm4',
      returnStage: 'm4_diagnosis',
      question: 'What customer language is common for this niche?',
    });
    expect(routeAfterM4(diagnosisOutput({ decision: 'collect_more_data' }))).toEqual({
      type: 'wait',
      reason: 'diagnosis requires more data',
    });
  });

  it('routes M5 research needs as a side-route and otherwise advances to test planning', () => {
    expect(routeAfterM5(hypothesisOutput({ researchNeed: 'Check buyer wording' }))).toEqual({
      type: 'research',
      requester: 'm5',
      returnStage: 'm5_hypothesis',
      question: 'Check buyer wording',
    });
    expect(routeAfterM5(hypothesisOutput())).toEqual({ type: 'advance', nextStage: 'm6_test_plan' });
  });

  it('routes M6 to experiment wait only when no research or unresolved rules remain', () => {
    expect(routeAfterM6(testPlanOutput())).toEqual({
      type: 'wait',
      reason: 'experiment plan ready for manual execution',
      nextStage: 'experiment_wait',
    });
    expect(routeAfterM6(testPlanOutput({ unresolvedMeasurementRules: ['Need baseline window'] }))).toEqual({
      type: 'research',
      requester: 'm6',
      returnStage: 'm6_test_plan',
      question: 'Resolve experiment measurement rules',
    });
  });

  it('routes post-experiment metrics to learning', () => {
    expect(routeAfterM2Results(metricsOutput({ phase: 'post_experiment' }))).toEqual({
      type: 'advance',
      nextStage: 'm7_learning',
    });
  });

  it('treats M7 wait as current-cycle completion, not a new automatic run', () => {
    expect(routeAfterM7(evaluationOutput({ nextAction: 'wait' }))).toEqual({
      type: 'complete',
      reason: 'learning complete; wait before another cycle',
    });
  });
});

function metricsOutput(overrides: Partial<MetricsOutput> = {}): MetricsOutput {
  return {
    phase: 'initial',
    comparisonQuality: 'valid',
    unresolvedQualificationNeeds: [],
    metrics: [
      {
        name: 'conversion_rate',
        current: 0.02,
        baseline: 0.01,
        absoluteChange: 0.01,
        percentageChange: 100,
        qualification: 'improved',
        confidence: 'moderate',
      },
    ],
    ...overrides,
  };
}

function diagnosisOutput(overrides: Partial<DiagnosisOutput> = {}): DiagnosisOutput {
  return {
    performancePath: 'conversion',
    primaryBottleneck: 'Title does not match buyer intent',
    confidence: 'moderate',
    decision: 'proceed_to_hypothesis',
    notes: [],
    ...overrides,
  };
}

function hypothesisOutput(overrides: Partial<HypothesisOutput> = {}): HypothesisOutput {
  return {
    hypothesis: 'Clearer buyer language will improve conversion.',
    primaryVariable: 'title',
    recommendedRevision: 'Printable Weekly Planner for Busy Moms',
    keepConstant: ['price', 'photos'],
    expectedSignal: 'Conversion rate improves',
    notes: [],
    ...overrides,
  };
}

function testPlanOutput(overrides: Partial<TestPlanOutput> = {}): TestPlanOutput {
  return {
    primaryMetric: 'conversion_rate',
    secondaryMetrics: ['views'],
    baselineValue: 0.02,
    baselinePeriod: 'last 30 days',
    qualificationRequirements: [],
    expectedSupportingSignal: 'More orders at similar traffic',
    expectedWeakeningSignal: 'Lower conversion',
    inconclusiveCondition: 'Traffic too low',
    contextToMonitor: ['seasonality'],
    unresolvedMeasurementRules: [],
    ...overrides,
  };
}

function evaluationOutput(overrides: Partial<EvaluationOutput> = {}): EvaluationOutput {
  return {
    outcome: 'inconclusive',
    hypothesisEvaluation: 'inconclusive',
    evidence: ['Traffic was too low'],
    contextualFactors: [],
    learning: 'Need more time before deciding.',
    confidence: 'low',
    knowledgeSource: 'experiment',
    nextAction: 'wait',
    nextActionRationale: 'Wait for more observations.',
    ...overrides,
  };
}

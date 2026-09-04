import { describe, expect, it } from 'vitest';
import { parseWithSchema } from '../../contracts/workflow.js';
import {
  runResearchModule,
  type ResearchRequest,
  type ResearchTool,
  type ResearchToolResult,
  type ToolCitation,
} from '../../agents/research/agent.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  TraceContext,
} from '../../agents/runner.js';
import type { ResearchOutput } from '../../contracts/modules.js';

describe('M3 bounded research module', () => {
  it('continues through requested permitted lookups and returns the final structured finding', async () => {
    const runner = new SequenceRunner([
      researchOutput({
        next_action: 'continue',
        requestedLookup: lookup('hosted_web_search', 'Find buyer language'),
      }),
      researchOutput({
        next_action: 'continue',
        requestedLookup: lookup('normalized_evidence', 'Check normalized listing evidence'),
      }),
      researchOutput({
        status: 'resolved',
        next_action: 'stop',
        evidence: [citation({ title: 'Resolved citation' })],
      }),
    ]);
    const webSearch = recordingTool('hosted_web_search');
    const normalizedEvidence = recordingTool('normalized_evidence');

    const output = await runResearchModule({
      runner,
      tools: [webSearch, normalizedEvidence],
      request: researchRequest(),
      trace: trace(),
    });

    expect(output).toMatchObject({
      status: 'resolved',
      next_action: 'stop',
      evidence: [expect.objectContaining({ title: 'Resolved citation' })],
    });
    expect(webSearch.calls).toEqual([{ query: 'buyer language' }]);
    expect(normalizedEvidence.calls).toEqual([{ listingId: 'listing-123' }]);
    expect(runner.inputs).toHaveLength(3);
    expect(runner.inputs.at(-1)?.input).toMatchObject({
      toolEvidence: [
        expect.objectContaining({ tool: 'hosted_web_search' }),
        expect.objectContaining({ tool: 'normalized_evidence' }),
      ],
    });
  });

  it('forces stop after the default three-tool-call cap is reached', async () => {
    const runner = new SequenceRunner([
      researchOutput({ next_action: 'continue', requestedLookup: lookup('hosted_web_search', 'First lookup') }),
      researchOutput({ next_action: 'continue', requestedLookup: lookup('hosted_web_search', 'Second lookup') }),
      researchOutput({ next_action: 'continue', requestedLookup: lookup('hosted_web_search', 'Third lookup') }),
      researchOutput({ next_action: 'continue', requestedLookup: lookup('hosted_web_search', 'Fourth lookup') }),
    ]);
    const webSearch = recordingTool('hosted_web_search');

    const output = await runResearchModule({
      runner,
      tools: [webSearch],
      request: researchRequest(),
      trace: trace(),
    });

    expect(output.next_action).toBe('stop');
    expect(output.status).toBe('partly_resolved');
    expect(webSearch.calls).toHaveLength(3);
    expect(runner.inputs).toHaveLength(3);
  });

  it('forces stop when the wall-clock limit is reached before another lookup', async () => {
    const runner = new SequenceRunner([
      researchOutput({
        next_action: 'continue',
        evidence: [],
        requestedLookup: lookup('hosted_web_search', 'Timed lookup'),
      }),
    ]);
    const webSearch = recordingTool('hosted_web_search');
    const times = [0, 120_001];

    const output = await runResearchModule({
      runner,
      tools: [webSearch],
      request: researchRequest(),
      now: () => times.shift() ?? 120_001,
      trace: trace(),
    });

    expect(output.next_action).toBe('stop');
    expect(webSearch.calls).toHaveLength(0);
  });

  it('rejects web citations that omit a URL', async () => {
    const runner = new SequenceRunner([
      researchOutput({
        next_action: 'stop',
        evidence: [
          {
            source: 'web',
            title: 'Missing URL',
            excerpt: 'Web evidence without URL is invalid.',
            fetchedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
      }),
    ]);

    await expect(
      runResearchModule({ runner, tools: [], request: researchRequest(), trace: trace() }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'm3 output failed validation',
    });
  });

  it('rejects tools outside the permitted research tool names before use', async () => {
    const unexpectedTool = recordingTool('write_listing' as never);

    await expect(
      runResearchModule({
        runner: new SequenceRunner([]),
        tools: [unexpectedTool],
        request: researchRequest(),
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: 'configuration_failed',
      message: 'M3 research tool is not permitted: write_listing',
    });
    expect(unexpectedTool.calls).toHaveLength(0);
  });

  it('rejects blocked status while accepting unresolved status', async () => {
    await expect(
      runResearchModule({
        runner: new SequenceRunner([researchOutput({ status: 'blocked' as never, next_action: 'stop' })]),
        tools: [],
        request: researchRequest(),
        trace: trace(),
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'm3 output failed validation',
    });

    const unresolved = await runResearchModule({
      runner: new SequenceRunner([researchOutput({ status: 'unresolved', next_action: 'stop', evidence: [] })]),
      tools: [],
      request: researchRequest(),
      trace: trace(),
    });

    expect(unresolved.status).toBe('unresolved');
    expect(unresolved.next_action).toBe('stop');
  });

  it('returns tool-backed citations and deterministic search summaries', async () => {
    const summary = completedSearchSummary();
    const webEvidence = webCitation('https://docs.example.test/guide');
    const runner = new SequenceRunner([
      researchOutput({
        next_action: 'continue',
        evidence: [],
        requestedLookup: lookup('hosted_web_search', 'Synthetic lookup'),
      }),
      researchOutput({ evidence: [webEvidence], searchSummaries: [{ ...summary, citationCount: 99 }] }),
    ]);
    const tool = recordingTool('hosted_web_search', {
      citations: [webEvidence],
      data: { searchSummaries: [summary] },
    });

    const output = await runResearchModule({
      runner,
      tools: [tool],
      request: researchRequest(),
      trace: trace(),
    });

    expect(output.evidence).toEqual([webEvidence]);
    expect(output.searchSummaries).toEqual([summary]);
  });

  it('can run one deterministic initial lookup before the first synthesis turn', async () => {
    const webEvidence = webCitation('https://docs.example.test/guide');
    const tool = recordingTool('hosted_web_search', {
      citations: [webEvidence],
      data: { searchSummaries: [completedSearchSummary()] },
    });
    const runner = new SequenceRunner([researchOutput({ evidence: [webEvidence] })]);

    const output = await runResearchModule({
      runner,
      tools: [tool],
      initialLookup: {
        tool: 'hosted_web_search',
        input: { query: 'What official guidance applies?' },
      },
      request: researchRequest(),
      trace: trace(),
    });

    expect(tool.calls).toEqual([{ query: 'What official guidance applies?' }]);
    expect(runner.inputs[0]?.input).toMatchObject({
      toolEvidence: [expect.objectContaining({ tool: 'hosted_web_search', citations: [webEvidence] })],
    });
    expect(output.evidence).toEqual([webEvidence]);
  });

  it('rejects a final web citation that was not returned by a tool', async () => {
    const runner = new SequenceRunner([
      researchOutput({
        next_action: 'continue',
        evidence: [],
        requestedLookup: lookup('hosted_web_search', 'Synthetic lookup'),
      }),
      researchOutput({ evidence: [webCitation('https://unmatched.example.test/guide')] }),
    ]);

    await expect(
      runResearchModule({
        runner,
        tools: [
          recordingTool('hosted_web_search', {
            citations: [webCitation('https://docs.example.test/guide')],
            data: { searchSummaries: [completedSearchSummary()] },
          }),
        ],
        request: researchRequest(),
        trace: trace(),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('keeps the latest tool citations when the call limit is reached', async () => {
    const webEvidence = webCitation('https://docs.example.test/guide');
    const output = await runResearchModule({
      runner: new SequenceRunner([
        researchOutput({
          next_action: 'continue',
          evidence: [],
          requestedLookup: lookup('hosted_web_search', 'Synthetic lookup'),
        }),
      ]),
      tools: [
        recordingTool('hosted_web_search', {
          citations: [webEvidence],
          data: { searchSummaries: [completedSearchSummary()] },
        }),
      ],
      limits: { maxToolCalls: 1 },
      request: researchRequest(),
      trace: trace(),
    });

    expect(output).toMatchObject({
      next_action: 'stop',
      evidence: [expect.objectContaining({ url: 'https://docs.example.test/guide' })],
      searchSummaries: [expect.objectContaining({ pass: 'authoritative_domains' })],
    });
  });
});

class SequenceRunner implements AgentRunner {
  readonly inputs: AgentRunInput<unknown>[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async runStructured<TOutput>(input: AgentRunInput<TOutput>): Promise<AgentRunResult<TOutput>> {
    this.inputs.push(input as AgentRunInput<unknown>);
    const output = this.outputs.shift();

    return {
      output: parseWithSchema(input.outputSchema, output, `${input.moduleId} output`) as TOutput,
    };
  }
}

function recordingTool(
  name: ResearchTool['name'],
  result?: ResearchToolResult,
): ResearchTool & { calls: Record<string, unknown>[] } {
  return {
    name,
    calls: [],
    async call(input: Record<string, unknown>): Promise<ResearchToolResult> {
      this.calls.push(input);

      return result ?? {
        citations: [toolCitation({ title: `${name} result`, source: name === 'hosted_web_search' ? 'web' : 'etsy' })],
        data: { ok: true },
      };
    },
  };
}

function webCitation(url: string): ToolCitation {
  return {
    source: 'web',
    title: 'Official guide',
    url,
    excerpt: 'Synthetic official guidance.',
    fetchedAt: '2026-08-31T00:00:00.000Z',
    domain: new URL(url).hostname,
    sourceType: 'official_platform',
    retrievalMethod: 'openai_hosted_web_search',
    searchPass: 'authoritative_domains',
  };
}

function completedSearchSummary() {
  return {
    pass: 'authoritative_domains' as const,
    status: 'completed' as const,
    citationCount: 1,
    officialCitationCount: 1,
    broaderCitationCount: 0,
    allowedDomainCount: 2,
    totalTokens: 12,
    estimatedCostUsd: 0.01,
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: '2026-08-31T00:00:01.000Z',
  };
}

function researchRequest(): ResearchRequest {
  return {
    requester: 'm5',
    question: 'What buyer language should this listing use?',
    reason: 'M5 needs evidence before selecting final wording',
  };
}

function trace(): TraceContext {
  return { runId: 'run-123', stage: 'm3_research' };
}

function lookup(tool: ResearchTool['name'], reason: string): ResearchOutput['requestedLookup'] {
  return {
    tool,
    reason,
    input: tool === 'normalized_evidence' ? { listingId: 'listing-123' } : { query: 'buyer language' },
  };
}

function researchOutput(overrides: Partial<ResearchOutput> = {}): ResearchOutput {
  return {
    status: 'partly_resolved',
    next_action: 'stop',
    requester: 'm5',
    question: 'What buyer language should this listing use?',
    evidence: [citation()],
    confidence: 'moderate',
    limitations: [],
    ...overrides,
  };
}

function citation(
  overrides: Partial<ResearchOutput['evidence'][number]> = {},
): ResearchOutput['evidence'][number] {
  const source = overrides.source ?? 'web';

  return {
    source,
    title: 'Buyer wording citation',
    ...(source === 'web' ? { url: 'https://example.com/buyer-wording' } : {}),
    excerpt: 'Planner buyers often search using practical weekly planning terms.',
    fetchedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function toolCitation(overrides: Partial<ToolCitation> = {}): ToolCitation {
  const source = overrides.source ?? 'web';

  return {
    source,
    title: 'Buyer wording citation',
    ...(source === 'web' ? { url: 'https://example.com/buyer-wording' } : {}),
    excerpt: 'Planner buyers often search using practical weekly planning terms.',
    fetchedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

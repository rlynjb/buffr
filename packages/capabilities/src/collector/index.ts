import type { DataConnector } from '@buffr/connectors';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type CollectorSource<P> = {
  connector: DataConnector<P, unknown>;
  params: P;
  optional?: boolean;
};

export type CollectorEvent =
  | { type: 'start'; sourceId: string }
  | { type: 'done'; sourceId: string; count: number }
  | { type: 'failed'; sourceId: string; reason: string; optional: boolean };

export type CollectorInput = {
  sources: CollectorSource<unknown>[];
  onEvent?: (event: CollectorEvent) => void;
};

export type CollectorOutput = {
  evidence: Evidence[];
  failed: Array<{ sourceId: string; reason: string }>;
};

export class Collector implements Capability<CollectorInput, CollectorOutput> {
  readonly name = 'collector';
  readonly version = '1.0.0';

  async execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>> {
    const onEvent = input.onEvent;
    const evidence: Evidence[] = [];
    const failed: Array<{ sourceId: string; reason: string }> = [];
    const warnings: string[] = [];

    await Promise.all(
      input.sources.map(async (source) => {
        onEvent?.({ type: 'start', sourceId: source.connector.id });
        try {
          const result = await source.connector.fetch(source.params);
          const evs = result.toEvidence();
          evidence.push(...evs);
          onEvent?.({ type: 'done', sourceId: source.connector.id, count: evs.length });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          failed.push({ sourceId: source.connector.id, reason });
          onEvent?.({ type: 'failed', sourceId: source.connector.id, reason, optional: source.optional ?? false });
          if (!(source.optional ?? false)) {
            warnings.push(`Required source '${source.connector.id}' failed: ${reason}`);
          }
        }
      }),
    );

    return {
      data: { evidence, failed },
      confidence: 1,
      evidence,
      assumptions: [],
      warnings,
      traceId: context.traceId,
    };
  }
}

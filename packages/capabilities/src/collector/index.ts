import type { DataConnector } from '@buffr/connectors';
import type { Evidence, AgentContext, AgentResult, Capability } from '@buffr/contracts';

export type CollectorSource<P> = {
  connector: DataConnector<P, unknown>;
  params: P;
  optional?: boolean;
};

export type CollectorInput = {
  sources: CollectorSource<unknown>[];
};

export type CollectorOutput = {
  evidence: Evidence[];
  failed: Array<{ sourceId: string; reason: string }>;
};

export class Collector implements Capability<CollectorInput, CollectorOutput> {
  readonly name = 'collector';
  readonly version = '1.0.0';

  async execute(input: CollectorInput, context: AgentContext): Promise<AgentResult<CollectorOutput>> {
    const results = await Promise.allSettled(
      input.sources.map(source => source.connector.fetch(source.params)),
    );

    const evidence: Evidence[] = [];
    const failed: Array<{ sourceId: string; reason: string }> = [];
    const warnings: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      const source = input.sources[i];
      if (settled.status === 'fulfilled') {
        evidence.push(...settled.value.toEvidence());
      } else {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        failed.push({ sourceId: source.connector.id, reason });
        if (!(source.optional ?? false)) {
          warnings.push(`Required source '${source.connector.id}' failed: ${reason}`);
        }
      }
    }

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

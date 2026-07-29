import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../src/collector/index.js';
import type { AgentContext, Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult } from '@buffr/connectors';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'test',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

function makeConnector(id: string, evidenceItems: Evidence[]): DataConnector<Record<string, never>, unknown> {
  return {
    id,
    async fetch(_params, _opts): Promise<ConnectorResult<unknown>> {
      return {
        data: {},
        fetchedAt: ctx.now,
        sourceId: id,
        toEvidence() { return evidenceItems; },
      };
    },
  };
}

function makeFailingConnector(id: string): DataConnector<Record<string, never>, unknown> {
  return {
    id,
    async fetch(_params, _opts): Promise<ConnectorResult<unknown>> {
      throw new Error(`network error from ${id}`);
    },
  };
}

const sampleEvidence: Evidence = {
  sourceId: 'src-a',
  sourceType: 'test',
  retrievedAt: ctx.now,
};

describe('Collector', () => {
  it('collects evidence from all successful sources', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      {
        sources: [
          { connector: makeConnector('src-a', [sampleEvidence]), params: {} },
          { connector: makeConnector('src-b', [{ ...sampleEvidence, sourceId: 'src-b' }]), params: {} },
        ],
      },
      ctx,
    );
    assert.strictEqual(result.data.evidence.length, 2);
    assert.strictEqual(result.data.failed.length, 0);
  });

  it('records a failed source in failed[]', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      {
        sources: [
          { connector: makeConnector('src-a', [sampleEvidence]), params: {} },
          { connector: makeFailingConnector('src-fail'), params: {} },
        ],
      },
      ctx,
    );
    assert.strictEqual(result.data.evidence.length, 1);
    assert.strictEqual(result.data.failed.length, 1);
    assert.strictEqual(result.data.failed[0].sourceId, 'src-fail');
    assert.ok(result.data.failed[0].reason.includes('network error'));
  });

  it('adds a warning for non-optional source failure', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeFailingConnector('required-src'), params: {}, optional: false }] },
      ctx,
    );
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('required-src'));
  });

  it('does NOT add a warning for optional source failure', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeFailingConnector('optional-src'), params: {}, optional: true }] },
      ctx,
    );
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.data.failed.length, 1);
  });

  it('sets confidence to 1 and traceId from context', async () => {
    const collector = new Collector();
    const result = await collector.execute(
      { sources: [{ connector: makeConnector('src-a', [sampleEvidence]), params: {} }] },
      ctx,
    );
    assert.strictEqual(result.confidence, 1);
    assert.strictEqual(result.traceId, ctx.traceId);
  });
});

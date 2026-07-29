import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal/index.js';
import type { AgentContext } from '@buffr/contracts';

const ctx: AgentContext = {
  userId: 'u1',
  workspaceId: 'w1',
  traceId: 't1',
  domain: 'investing',
  now: '2026-07-29T00:00:00.000Z',
  permissions: [],
};

const baseInput = {
  subject: { type: 'stock', id: 'ACME', description: 'ACME Corp Q3 earnings review' },
  domain: 'investing',
  decision: 'Buy ACME at $45',
  thesis: 'Revenue growth and margin expansion will drive re-rating.',
  expectedOutcome: 'Stock reaches $60 within 12 months.',
};

describe('Journal', () => {
  it('sets userId and workspaceId from context', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.userId, 'u1');
    assert.strictEqual(result.data.entry.workspaceId, 'w1');
  });

  it('sets status to "open" always', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.status, 'open');
  });

  it('generates a valid UUID for id', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.match(result.data.entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('defaults confidence to 0.5 when omitted', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.confidence, 0.5);
    assert.strictEqual(result.confidence, 0.5);
  });

  it('uses provided confidence when given', async () => {
    const journal = new Journal();
    const result = await journal.execute({ ...baseInput, confidence: 0.8 }, ctx);
    assert.strictEqual(result.data.entry.confidence, 0.8);
    assert.strictEqual(result.confidence, 0.8);
  });

  it('sets reviewAt when provided', async () => {
    const journal = new Journal();
    const result = await journal.execute({ ...baseInput, reviewAt: '2026-10-29T00:00:00.000Z' }, ctx);
    assert.strictEqual(result.data.entry.reviewAt, '2026-10-29T00:00:00.000Z');
  });

  it('omits reviewAt when not provided', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.reviewAt, undefined);
  });

  it('defaults assumptions, risks, evidenceIds to empty arrays', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.deepEqual(result.data.entry.assumptions, []);
    assert.deepEqual(result.data.entry.risks, []);
    assert.deepEqual(result.data.entry.evidenceIds, []);
  });

  it('sets createdAt from context.now', async () => {
    const journal = new Journal();
    const result = await journal.execute(baseInput, ctx);
    assert.strictEqual(result.data.entry.createdAt, ctx.now);
  });
});

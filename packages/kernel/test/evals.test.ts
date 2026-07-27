import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scorePrecisionAtK, scoreRecallAtK } from '../src/evals/index.js';

describe('scorePrecisionAtK', () => {
  it('scores 1.0 when top-k are all relevant', () => {
    const result = scorePrecisionAtK(['a', 'b', 'c'], new Set(['a', 'b', 'c']), 3);
    assert.ok(result.ok);
    assert.strictEqual(result.score, 1);
    assert.strictEqual(result.matched, 3);
  });

  it('scores 0.5 when half of top-k are relevant', () => {
    const result = scorePrecisionAtK(['a', 'x'], new Set(['a']), 2);
    assert.ok(result.ok);
    assert.strictEqual(result.score, 0.5);
  });

  it('returns ok:false for k<=0', () => {
    const result = scorePrecisionAtK(['a'], new Set(['a']), 0);
    assert.ok(!result.ok);
  });

  it('uses actual retrieved count when fewer than k returned', () => {
    const result = scorePrecisionAtK(['a'], new Set(['a']), 10);
    assert.ok(result.ok);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.score, 1);
  });
});

describe('scoreRecallAtK', () => {
  it('scores 1.0 when all relevant ids appear in top-k', () => {
    const result = scoreRecallAtK(['a', 'b'], new Set(['a', 'b']), 2);
    assert.ok(result.ok);
    assert.strictEqual(result.score, 1);
  });

  it('scores 0.5 when half of relevant ids appear in top-k', () => {
    const result = scoreRecallAtK(['a', 'x'], new Set(['a', 'b']), 2);
    assert.ok(result.ok);
    assert.strictEqual(result.score, 0.5);
  });

  it('returns ok:false for empty relevantIds', () => {
    const result = scoreRecallAtK(['a'], new Set(), 3);
    assert.ok(!result.ok);
  });
});

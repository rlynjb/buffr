import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { timestamp } from '../src/tracing.js';

describe('timestamp', () => {
  it('returns an ISO string', () => {
    const ts = timestamp();
    assert.ok(!isNaN(Date.parse(ts)), `expected ISO string, got: ${ts}`);
  });
});

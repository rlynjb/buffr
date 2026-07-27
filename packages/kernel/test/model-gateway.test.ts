import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTextTokens, estimateContextWindow, ContextWindowExceededError } from '../src/model-gateway/index.js';
import type { ModelRequest } from '../src/model-gateway/index.js';

describe('estimateTextTokens', () => {
  it('divides char count by charsPerToken', () => {
    assert.strictEqual(estimateTextTokens('abc', 3), 1);
    assert.strictEqual(estimateTextTokens('abcdef', 3), 2);
  });

  it('rounds up', () => {
    assert.strictEqual(estimateTextTokens('abcd', 3), 2);
  });
});

describe('estimateContextWindow', () => {
  const req: ModelRequest = {
    system: 'you are helpful',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('returns ok:true when under budget', () => {
    const result = estimateContextWindow(req, { maxTokens: 8192, outputReserve: 768, charsPerToken: 3 });
    assert.ok(result.ok);
  });

  it('returns ok:false when over budget', () => {
    const result = estimateContextWindow(req, { maxTokens: 2, outputReserve: 1, charsPerToken: 3 });
    assert.ok(!result.ok);
  });
});

describe('ContextWindowExceededError', () => {
  it('is an Error subclass', () => {
    const err = new ContextWindowExceededError({ estimatedInputTokens: 10, maxTokens: 5, outputReserve: 2, availableInputTokens: 3, ok: false });
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'ContextWindowExceededError');
  });
});

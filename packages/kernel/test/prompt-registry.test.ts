import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PromptRegistry } from '../src/prompt-registry/index.js';

describe('PromptRegistry', () => {
  it('retrieves a registered prompt by name', () => {
    const r = new PromptRegistry();
    r.register('my/prompt', '1.0.0', 'Hello {{name}}');
    const entry = r.get('my/prompt');
    assert.strictEqual(entry.template, 'Hello {{name}}');
    assert.strictEqual(entry.version, '1.0.0');
    assert.strictEqual(entry.name, 'my/prompt');
  });

  it('returns the latest version when no version arg given', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    r.register('p', '2.0.0', 'v2');
    assert.strictEqual(r.get('p').version, '2.0.0');
    assert.strictEqual(r.get('p').template, 'v2');
  });

  it('retrieves a specific older version', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    r.register('p', '2.0.0', 'v2');
    assert.strictEqual(r.get('p', '1.0.0').template, 'v1');
  });

  it('throws for unknown name', () => {
    const r = new PromptRegistry();
    assert.throws(() => r.get('unknown'), /No prompt registered for "unknown"/);
  });

  it('throws for unknown version', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    assert.throws(() => r.get('p', '9.0.0'), /No prompt registered for "p@9\.0\.0"/);
  });

  it('has() returns true for a registered name', () => {
    const r = new PromptRegistry();
    r.register('p', '1.0.0', 'v1');
    assert.strictEqual(r.has('p'), true);
    assert.strictEqual(r.has('p', '1.0.0'), true);
    assert.strictEqual(r.has('missing'), false);
    assert.strictEqual(r.has('p', '9.0.0'), false);
  });

  it('list() returns all registered entries', () => {
    const r = new PromptRegistry();
    r.register('a', '1.0.0', 'A');
    r.register('b', '1.0.0', 'B');
    assert.strictEqual(r.list().length, 2);
  });
});

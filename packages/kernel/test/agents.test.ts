import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderPromptTemplate, injectProfile, RagQueryAgent } from '../src/agents/index.js';
import { InMemoryToolRegistry } from '../src/tool-runtime/registry.js';
import { SEARCH_KNOWLEDGE_BASE_TOOL_NAME } from '../src/retrieval/search-tool.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/model-gateway/types.js';

describe('renderPromptTemplate', () => {
  it('replaces {variable} placeholders', () => {
    const result = renderPromptTemplate('Hello {name}!', { name: 'world' });
    assert.strictEqual(result, 'Hello world!');
  });

  it('leaves unknown placeholders untouched', () => {
    const result = renderPromptTemplate('Hello {unknown}!', {});
    assert.strictEqual(result, 'Hello {unknown}!');
  });
});

describe('injectProfile', () => {
  it('prepends profile to template by default', () => {
    const result = injectProfile('system prompt', 'profile text');
    assert.ok(result.startsWith('profile text'));
    assert.ok(result.includes('system prompt'));
  });

  it('appends profile when position is end', () => {
    const result = injectProfile('system prompt', 'profile text', { position: 'end' });
    assert.ok(result.endsWith('profile text'));
  });
});

class StubModel implements ModelProvider {
  readonly id = 'stub';
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { content: [{ type: 'text', text: 'the answer is 42' }] };
  }
}

describe('RagQueryAgent', () => {
  it('returns a string answer', async () => {
    const searchTool = {
      name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    };
    const tools = new InMemoryToolRegistry([searchTool], {
      [SEARCH_KNOWLEDGE_BASE_TOOL_NAME]: async () => ({ query: 'test', results: [] }),
    });
    const agent = new RagQueryAgent({ model: new StubModel(), tools });
    const answer = await agent.answer('what is the answer?');
    assert.strictEqual(typeof answer, 'string');
    assert.ok(answer.length > 0);
  });
});

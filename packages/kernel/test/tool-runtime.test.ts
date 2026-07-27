import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryToolRegistry, filterToolsForPolicy } from '../src/tool-runtime/index.js';
import type { ToolDefinition } from '../src/tool-runtime/index.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Returns the input unchanged.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

describe('InMemoryToolRegistry', () => {
  it('lists registered tools', () => {
    const registry = new InMemoryToolRegistry([echoTool], {
      echo: async (args) => args['text'],
    });
    const tools = registry.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0]!.name, 'echo');
  });

  it('calls the registered handler', async () => {
    const registry = new InMemoryToolRegistry([echoTool], {
      echo: async (args) => args['text'],
    });
    const result = await registry.callTool('echo', { text: 'hello' });
    assert.strictEqual(result.result, 'hello');
    assert.ok(typeof result.durationMs === 'number');
  });

  it('throws for unknown tool name', async () => {
    const registry = new InMemoryToolRegistry([], {});
    await assert.rejects(() => registry.callTool('unknown', {}), /tool not found/);
  });
});

describe('filterToolsForPolicy', () => {
  it('returns only allowed tools as ModelTool array', () => {
    const all = [
      { name: 'search', description: 'search', inputSchema: {} },
      { name: 'write', description: 'write', inputSchema: {} },
    ];
    const result = filterToolsForPolicy(all, { capabilityId: 'test', allowedTools: ['search'] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.name, 'search');
  });
});

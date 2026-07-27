import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentJson, buildSynthesisInstruction, runAgentLoop } from '../src/workflow-runtime/index.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/model-gateway/index.js';
import type { ToolRegistry } from '../src/tool-runtime/index.js';

describe('parseAgentJson', () => {
  it('parses a plain JSON string', () => {
    const result = parseAgentJson('{"tool": "search", "arguments": {}}');
    assert.deepStrictEqual(result, { tool: 'search', arguments: {} });
  });

  it('extracts JSON from markdown fences', () => {
    const result = parseAgentJson('```json\n{"ok":true}\n```');
    assert.deepStrictEqual(result, { ok: true });
  });

  it('extracts JSON from surrounding prose', () => {
    const result = parseAgentJson('here it is: {"x":1} done');
    assert.deepStrictEqual(result, { x: 1 });
  });

  it('throws when no JSON found', () => {
    assert.throws(() => parseAgentJson('no json here'), /no parseable json/);
  });
});

describe('buildSynthesisInstruction', () => {
  it('includes the supplied middle text', () => {
    const result = buildSynthesisInstruction('Answer now.');
    assert.ok(result.includes('Answer now.'));
    assert.ok(result.includes('NO more tool calls'));
  });
});

class StubModel implements ModelProvider {
  readonly id = 'stub';
  readonly responses: ModelResponse[];
  private index = 0;
  constructor(responses: ModelResponse[]) { this.responses = responses; }
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const resp = this.responses[this.index++];
    if (!resp) throw new Error('StubModel: no more responses');
    return resp;
  }
}

class StubRegistry implements ToolRegistry {
  listTools() { return []; }
  async callTool(name: string): Promise<{ result: unknown; durationMs: number }> {
    throw new Error(`unexpected callTool: ${name}`);
  }
}

describe('runAgentLoop', () => {
  it('returns the final text from a single-turn response', async () => {
    const model = new StubModel([
      { content: [{ type: 'text', text: 'the answer is 42' }] },
    ]);
    const result = await runAgentLoop({
      capabilityId: 'test',
      model,
      tools: new StubRegistry(),
      system: 'be helpful',
      userPrompt: 'what is 6 times 7?',
      toolSchemas: [],
    });
    assert.strictEqual(result.finalText, 'the answer is 42');
    assert.strictEqual(result.toolCalls.length, 0);
  });
});

// packages/kernel/src/tool-runtime/policy.ts
import type { ModelTool } from '../model-gateway/types.js';
import type { ToolDefinition } from './registry.js';

export type ToolPolicy = {
  capabilityId: string;
  allowedTools: readonly string[];
};

export function filterToolsForPolicy(
  allTools: readonly ToolDefinition[],
  policy: ToolPolicy,
): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema }));
}

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModuleId } from '../../contracts/modules.js';

export const M3_DEFAULT_LIMITS = {
  maxToolCalls: 3,
  maxWallClockMs: 120_000,
} as const;

export const M0_POLICY = readPolicyMarkdown();

export function buildModuleInstructions(moduleId: ModuleId, modulePrompt: string): string {
  return [`Module: ${moduleId}`, 'Shared M0 policy:', M0_POLICY, 'Module prompt:', modulePrompt.trim()].join(
    '\n\n',
  );
}

export function resolvePolicyMarkdownUrl(moduleUrl: string = import.meta.url): URL {
  const adjacentSource = new URL('./policy.md', moduleUrl);
  if (existsSync(adjacentSource)) {
    return adjacentSource;
  }

  return new URL('../../../src/agents/core/policy.md', moduleUrl);
}

function readPolicyMarkdown(): string {
  return readFileSync(fileURLToPath(resolvePolicyMarkdownUrl()), 'utf8').trim();
}

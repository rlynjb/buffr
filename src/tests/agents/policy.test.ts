import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  M0_POLICY,
  M3_DEFAULT_LIMITS,
  buildModuleInstructions,
  resolvePolicyMarkdownUrl,
} from '../../agents/core/policy.js';

describe('M0 core policy', () => {
  it('loads the shared policy from the co-located Markdown source', async () => {
    const markdown = await readFile(new URL('../../agents/core/policy.md', import.meta.url), 'utf8');

    expect(M0_POLICY).toBe(markdown.trim());
  });

  it('documents the required cross-module boundaries', () => {
    expect(M0_POLICY).toContain('observed fact');
    expect(M0_POLICY).toContain('calculated metric');
    expect(M0_POLICY).toContain('external research');
    expect(M0_POLICY).toContain('assumption');
    expect(M0_POLICY).toContain('interpretation');
    expect(M0_POLICY).toContain('hypothesis');
    expect(M0_POLICY).toContain('deterministic TypeScript workflow engine owns lifecycle routing');
    expect(M0_POLICY).toContain('Do not fabricate missing data');
    expect(M0_POLICY).toContain('Never expose raw credentials');
    expect(M0_POLICY).toContain('Do not include raw Etsy endpoint details');
    expect(M0_POLICY).toContain('Do not automate Etsy listing or shop changes');
    expect(M3_DEFAULT_LIMITS).toEqual({ maxToolCalls: 3, maxWallClockMs: 120_000 });
  });

  it('prepends common policy to module-specific prompt text', () => {
    const instructions = buildModuleInstructions('m4', 'M4 Diagnosis: identify one bottleneck.');

    expect(instructions).toContain('Module: m4');
    expect(instructions.indexOf(M0_POLICY)).toBeLessThan(instructions.indexOf('M4 Diagnosis'));
  });

  it('resolves source Markdown when loaded from current tsc dist output', () => {
    const distPolicyUrl = new URL('../../../dist/agents/core/policy.js', import.meta.url);

    expect(fileURLToPath(resolvePolicyMarkdownUrl(distPolicyUrl.href))).toMatch(
      /\/src\/agents\/core\/policy\.md$/,
    );
  });
});

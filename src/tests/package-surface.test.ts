import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  scripts?: Record<string, string>;
};

const packageUrl = new URL('../../package.json', import.meta.url);

describe('package command surface', () => {
  it('exposes one owner-facing marketplace review command', async () => {
    const manifest = JSON.parse(await readFile(packageUrl, 'utf8')) as PackageManifest;
    const scripts = manifest.scripts ?? {};

    expect(scripts['marketplace:review']).toBe('node dist/cli/marketplace-visibility.js review');
    expect(scripts).not.toHaveProperty('marketplace:next-review');
    expect(scripts).not.toHaveProperty('merchgrid:collect');
    expect(scripts).not.toHaveProperty('merchgrid:weekly-review');
  });
});

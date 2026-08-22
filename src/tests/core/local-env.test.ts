import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalEnvironment } from '../../core/local-env.js';

describe('loadLocalEnvironment', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('loads local source settings without replacing explicitly supplied environment values', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env'), 'POSTHOG_PROJECT_ID=from-file\nFLY_APP_NAME=merchgrid\n', 'utf8');
    const env: NodeJS.ProcessEnv = { POSTHOG_PROJECT_ID: 'from-shell' };

    loadLocalEnvironment({ cwd, env });

    expect(env).toEqual({ POSTHOG_PROJECT_ID: 'from-shell', FLY_APP_NAME: 'merchgrid' });
  });

  it('does nothing when the local env file is absent', async () => {
    const cwd = await temporaryDirectory();
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadLocalEnvironment({ cwd, env })).not.toThrow();
    expect(env).toEqual({});
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'buffr-local-env-'));
    temporaryDirectories.push(directory);
    return directory;
  }
});

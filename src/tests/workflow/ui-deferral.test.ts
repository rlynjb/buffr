import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorkflowEngine } from '../../workflow/engine.js';

describe('terminal-chat adapter deferral', () => {
  it('keeps terminal chat behind the engine-proof acceptance gate', async () => {
    expect(typeof createWorkflowEngine).toBe('function');
    await expect(access(new URL('../../chat', import.meta.url), constants.F_OK)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(
      'Terminal chat starts only after a mocked end-to-end lifecycle proves engine inputs, waits, resume behavior, outputs, traces, and persisted evidence.',
    );
  });
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

export type LocalEnvironmentOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** Loads optional local credentials for command entry points without replacing explicit environment values. */
export function loadLocalEnvironment(options: LocalEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const path = join(cwd, '.env');

  if (!existsSync(path)) {
    return env;
  }

  config({ path, processEnv: env as Record<string, string>, quiet: true });
  return env;
}

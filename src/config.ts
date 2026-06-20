export type Config = {
  databaseUrl?: string;
  appId: string;
  schema: string;
  ollamaHost: string;
};

/** Pure: env in, config out. The CLI passes process.env; tests pass a fixture. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    appId: env.AGENT_APP_ID || 'laptop',
    schema: env.AGENT_DB_SCHEMA || 'agents',
    ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
  };
}

export type Config = {
  databaseUrl?: string;
  appId: string;
  schema: string;
  ollamaHost: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
  googleApiKey?: string;
  googleCx?: string;
};

/** Pure: env in, config out. The CLI passes process.env; tests pass a fixture. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    appId: env.AGENT_APP_ID || 'laptop',
    schema: env.AGENT_DB_SCHEMA || 'agents',
    ollamaHost: env.OLLAMA_HOST || 'http://localhost:11434',
    braveApiKey: env.BRAVE_API_KEY || undefined,
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    googleApiKey: env.GOOGLE_API_KEY || undefined,
    googleCx: env.GOOGLE_CX || undefined,
  };
}

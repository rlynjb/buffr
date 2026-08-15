import { AppError } from './errors.js';

export type EtsyConnectorConfig = {
  apiKey: string;
  oauthClientId: string;
  oauthRedirectUri: string;
  tokenStoragePath: string;
  scopes: readonly string[];
};

export function loadEtsyConnectorConfig(env: NodeJS.ProcessEnv): EtsyConnectorConfig {
  return {
    apiKey: required(env, 'ETSY_API_KEY'),
    oauthClientId: required(env, 'ETSY_OAUTH_CLIENT_ID'),
    oauthRedirectUri: required(env, 'ETSY_OAUTH_REDIRECT_URI'),
    scopes: parseScopes(required(env, 'ETSY_OAUTH_SCOPES')),
    tokenStoragePath: required(env, 'ETSY_TOKEN_STORAGE_PATH'),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new AppError('configuration_failed', `Missing required Etsy connector configuration: ${name}`);
  }

  return value;
}

function parseScopes(value: string): readonly string[] {
  return value
    .split(/[,\s]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

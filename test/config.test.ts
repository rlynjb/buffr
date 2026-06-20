import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults appId, schema, and ollama host when env is sparse', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.appId, 'laptop');
    assert.equal(cfg.schema, 'agents');
    assert.equal(cfg.ollamaHost, 'http://localhost:11434');
    assert.equal(cfg.databaseUrl, undefined);
  });

  it('reads overrides from the provided env', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', AGENT_APP_ID: 'buffr', AGENT_DB_SCHEMA: 'agents2' });
    assert.equal(cfg.databaseUrl, 'postgres://x');
    assert.equal(cfg.appId, 'buffr');
    assert.equal(cfg.schema, 'agents2');
  });
});

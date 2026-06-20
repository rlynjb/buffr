import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@aptkit/retrieval';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { indexDocumentRow } from '../runtime.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error('usage: npm run index -- <file.md> [more.md...]');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

for (const path of paths) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
  process.stdout.write(`indexed ${path}\n`);
}
await pool.end();

import { config as loadEnv } from 'dotenv';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@buffr/kernel';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { indexDocumentRow } from '../runtime.js';
import { DB_SOURCES } from '../db-sources.js';

// Strip all UTF-16 surrogates before chunking. The chunker slices at code-unit
// boundaries, which can split valid surrogate pairs (emoji) into lone surrogates
// that Postgres rejects in JSON columns (error 22P02).
function sanitize(s: string): string {
  return s.replace(/[\uD800-\uDFFF]/g, '');
}

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

for (const source of DB_SOURCES) {
  const { rows } = await pool.query(source.query);
  for (const row of rows) {
    await indexDocumentRow(pool, cfg.appId, pipeline, {
      id: source.toId(row),
      text: sanitize(source.toText(row)),
      sourceType: 'db',
    });
  }
  process.stdout.write(`indexed ${source.schema}.${source.table} (${rows.length} rows)\n`);
}

await pool.end();

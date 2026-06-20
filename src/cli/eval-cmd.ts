import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@aptkit/retrieval';
import { scorePrecisionAtK, scoreRecallAtK } from '@aptkit/evals';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

// dist/src/cli/eval-cmd.js -> ../../../ reaches the project root.
const queries: { query: string; relevant: string[] }[] = JSON.parse(
  await readFile(new URL('../../../eval/queries.json', import.meta.url), 'utf8'));

const K = 3;
let p1 = 0, rk = 0;
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);
  const docs = [...new Set(hits.map((h) => String(h.meta.docId)))];
  const p = scorePrecisionAtK(docs, new Set(relevant), 1).score;
  const r = scoreRecallAtK(docs, new Set(relevant), K).score;
  p1 += p;
  rk += r;
  process.stdout.write(`${query.padEnd(44)} P@1 ${p.toFixed(2)}  R@${K} ${r.toFixed(2)}\n`);
}
process.stdout.write(`\nmean P@1 ${(p1 / queries.length).toFixed(2)}  mean R@${K} ${(rk / queries.length).toFixed(2)}\n`);
await pool.end();

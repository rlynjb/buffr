import { config as loadEnv } from 'dotenv';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { OllamaEmbeddingProvider, createRetrievalPipeline } from '@buffr/kernel';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { PgVectorStore } from '../pg-vector-store.js';
import { indexDocumentRow } from '../runtime.js';

async function collectMarkdownFiles(input: string): Promise<string[]> {
  const s = await stat(input);
  if (!s.isDirectory()) return input.endsWith('.md') ? [input] : [];
  const entries = await readdir(input, { recursive: true });
  return entries
    .filter((e) => e.endsWith('.md'))
    .map((e) => join(input, e));
}

loadEnv();
const cfg = loadConfig(process.env);
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (see .env)');

const args = process.argv.slice(2);
if (args.length === 0) throw new Error('usage: npm run index -- <file.md|dir> [...]');

const fileLists = await Promise.all(args.map(collectMarkdownFiles));
const files = fileLists.flat();
if (files.length === 0) throw new Error('no .md files found in the provided paths');

const pool = createPool(cfg.databaseUrl);
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5', host: cfg.ollamaHost });
const store = new PgVectorStore({ pool, appId: cfg.appId, dimension: embedder.dimension });
const pipeline = createRetrievalPipeline({ embedder, store });

for (const path of files) {
  const text = await readFile(path, 'utf8');
  await indexDocumentRow(pool, cfg.appId, pipeline, { id: basename(path), text, sourcePath: path });
  process.stdout.write(`indexed ${path}\n`);
}
await pool.end();

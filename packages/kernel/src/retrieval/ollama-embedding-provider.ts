// packages/kernel/src/retrieval/ollama-embedding-provider.ts
import type { EmbeddingProvider } from './contracts.js';

export type EmbedTransport = (payload: { model: string; texts: string[]; signal?: AbortSignal }) => Promise<number[][]>;

export type OllamaEmbeddingProviderOptions = {
  model?: string;
  host?: string;
  embed?: EmbedTransport;
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'nomic-embed-text';
  readonly dimension = 768;
  private readonly model: string;
  private readonly embedTransport: EmbedTransport;

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    this.model = options.model ?? 'nomic-embed-text';
    this.embedTransport = options.embed ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
  }

  async embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    return this.embedTransport({ model: this.model, texts, ...(options?.signal ? { signal: options.signal } : {}) });
  }
}

function defaultHttpTransport(host: string): EmbedTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: payload.model, input: payload.texts }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json() as { embeddings?: number[][] };
    return json.embeddings ?? [];
  };
}

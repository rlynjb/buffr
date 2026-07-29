import type { EmbeddingProvider } from './contracts.js';
import type { Cache } from '../cache/index.js';

export class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly cache: Cache<string, number[]>,
  ) {
    this.id = inner.id;
    this.dimension = inner.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results = new Array<number[] | undefined>(texts.length);
    const misses: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const hit = this.cache.get(texts[i]!);
      if (hit !== undefined) {
        results[i] = hit;
      } else {
        misses.push(i);
      }
    }

    if (misses.length > 0) {
      const embedded = await this.inner.embed(misses.map(i => texts[i]!));
      for (let j = 0; j < misses.length; j++) {
        const idx = misses[j]!;
        results[idx] = embedded[j]!;
        this.cache.set(texts[idx]!, embedded[j]!);
      }
    }

    return results as number[][];
  }
}

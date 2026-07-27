// packages/kernel/src/memory/conversation-memory.ts
import type { EmbeddingProvider, VectorHit, VectorStore } from '../retrieval/contracts.js';

export type MemoryTurn = { conversationId: string; question: string; answer: string };
export type MemoryHit = { id: string; score: number; text: string; conversationId?: string };

export type ConversationMemoryOptions = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  format?: (turn: MemoryTurn) => string;
  kind?: string;
};

export type ConversationMemory = {
  remember(turn: MemoryTurn): Promise<void>;
  recall(query: string, k?: number): Promise<MemoryHit[]>;
};

const DEFAULT_KIND = 'memory';
const DEFAULT_RECALL_K = 5;

function defaultFormat(turn: MemoryTurn): string {
  return `Past exchange — user asked: "${turn.question}"\nassistant answered: "${turn.answer}"`;
}

export function createConversationMemory(opts: ConversationMemoryOptions): ConversationMemory {
  const { embedder, store } = opts;
  if (embedder.dimension !== store.dimension) {
    throw new Error(`embedder dimension ${embedder.dimension} != store dimension ${store.dimension}`);
  }
  const kind = opts.kind ?? DEFAULT_KIND;
  const format = opts.format ?? defaultFormat;
  const counters = new Map<string, number>();

  return {
    async remember(turn: MemoryTurn): Promise<void> {
      const text = format(turn);
      const [vector] = await embedder.embed([text]);
      if (!vector) return;
      const n = counters.get(turn.conversationId) ?? 0;
      counters.set(turn.conversationId, n + 1);
      await store.upsert([{
        id: `${kind}:${turn.conversationId}:${n}`,
        vector,
        meta: { kind, conversationId: turn.conversationId, text },
      }]);
    },

    async recall(query: string, k = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
      const [vector] = await embedder.embed([query]);
      if (!vector) return [];
      const fetchK = Math.max(k * 4, 20);
      const hits = await store.search(vector, fetchK);
      return hits
        .filter((h: VectorHit) => h.meta?.['kind'] === kind)
        .slice(0, k)
        .map((h: VectorHit) => ({
          id: h.id,
          score: h.score,
          text: typeof h.meta?.['text'] === 'string' ? h.meta['text'] : '',
          conversationId: typeof h.meta?.['conversationId'] === 'string' ? h.meta['conversationId'] : undefined,
        }));
    },
  };
}

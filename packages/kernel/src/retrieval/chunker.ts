// packages/kernel/src/retrieval/chunker.ts

export const CHUNK_SIZE = 512;
export const CHUNK_OVERLAP = 64;

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

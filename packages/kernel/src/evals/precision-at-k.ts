// packages/kernel/src/evals/precision-at-k.ts

export type RetrievalScoreResult = {
  ok: boolean;
  score: number;
  matched: number;
  total: number;
};

const NOT_WELL_FORMED: RetrievalScoreResult = { ok: false, score: 0, matched: 0, total: 0 };

function countDistinctHits(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): number {
  const topK = retrievedIds.slice(0, k);
  const seen = new Set<string>();
  for (const id of topK) { if (relevantIds.has(id)) seen.add(id); }
  return seen.size;
}

export function scorePrecisionAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = Math.min(k, retrievedIds.length);
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}

export function scoreRecallAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = relevantIds.size;
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}

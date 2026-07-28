export function inferFreshness(dateStr?: string): 'live' | 'recent' | 'stale' | 'unknown' {
  if (!dateStr) return 'unknown';
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return 'unknown';
  const days = (Date.now() - ms) / 86_400_000;
  if (days < 1)  return 'live';
  if (days < 7)  return 'recent';
  return 'stale';
}

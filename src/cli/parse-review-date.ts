/**
 * Parses "<N>" (a positive integer — days from now) or a future ISO date
 * string into a future ISO timestamp. Returns null if unparseable or not
 * in the future. Shared by research-flow.ts (decision review-date capture)
 * and review-flow.ts (snooze-date capture) — one parser, one set of rules.
 */
export function parseDayCountOrDate(input: string): string | null {
  const trimmed = input.trim();
  const asInt = Number(trimmed);
  if (Number.isInteger(asInt) && asInt > 0) {
    const d = new Date();
    d.setDate(d.getDate() + asInt);
    return d.toISOString();
  }
  const asDate = new Date(trimmed);
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > Date.now()) {
    return asDate.toISOString();
  }
  return null;
}

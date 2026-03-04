/**
 * Strips markdown code-block fences from LLM JSON responses.
 * Common pattern: LLMs wrap JSON in ```json ... ``` blocks.
 */
export function stripCodeBlock(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned;
}

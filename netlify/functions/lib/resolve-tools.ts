import { executeTool } from "./tools/registry";

/**
 * Resolves {{tool:name}} and {{tool:name:params}} tokens in a template string.
 * Each token calls the named tool and replaces with the JSON result.
 * This runs server-side only — resolvePrompt() in src/lib stays synchronous.
 */
export async function resolveToolTokens(
  template: string,
  defaultInput?: Record<string, unknown>,
): Promise<string> {
  const TOKEN_RE = /\{\{tool:(\w+)(?::([^}]+))?\}\}/g;
  const matches = [...template.matchAll(TOKEN_RE)];

  if (matches.length === 0) return template;

  let result = template;

  // Process in reverse order to preserve string positions
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const toolName = match[1];
    const paramStr = match[2];

    let input: Record<string, unknown> = { ...defaultInput };
    if (paramStr) {
      try {
        // Try JSON first
        input = { ...input, ...JSON.parse(paramStr) };
      } catch {
        // Fall back to URL param format (key=value&key=value)
        if (paramStr.includes("=")) {
          const params = new URLSearchParams(paramStr);
          for (const [key, value] of params.entries()) {
            input[key] = value;
          }
        } else {
          input = { ...input, query: paramStr };
        }
      }
    }

    let replacement: string;
    try {
      const res = await executeTool(toolName, input);
      if (res.ok) {
        replacement = JSON.stringify(res.result);
      } else {
        replacement = `[Tool ${toolName} failed: ${res.error}]`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      replacement = `[Tool ${toolName} failed: ${msg}]`;
    }

    const start = match.index!;
    const end = start + match[0].length;
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

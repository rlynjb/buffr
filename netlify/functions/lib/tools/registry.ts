export interface Tool {
  name: string;
  description: string;
  integrationId: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool) {
  tools.set(tool.name, tool);
}

export function listToolsByIntegration(integrationId: string): Tool[] {
  return Array.from(tools.values()).filter(
    (t) => t.integrationId === integrationId
  );
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, error: `Tool "${name}" not found` };
  }
  try {
    const result = await tool.execute(input);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    return { ok: false, error: message };
  }
}

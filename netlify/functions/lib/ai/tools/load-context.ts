import type { AgentTool } from "./types";
import { listBuffrContextItems } from "../../storage/buffr-context";

interface LoadContextInput {
  projectId: string;
}

export const loadContext: AgentTool = {
  name: "loadContext",
  description: "Reads project context from buffr_context table. Returns the context.md content.",
  async execute(input: unknown): Promise<string> {
    const { projectId } = input as LoadContextInput;
    const items = await listBuffrContextItems(projectId);
    if (items.length === 0) return "";
    return items.map((i) => `# ${i.title}\n\n${i.content}`).join("\n\n---\n\n");
  },
};

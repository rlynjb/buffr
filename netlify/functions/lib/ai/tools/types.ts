export interface AgentTool {
  name: string;
  description: string;
  execute: (input: unknown) => Promise<unknown>;
}

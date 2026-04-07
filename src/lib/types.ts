export interface Project {
  id: string;
  name: string;
  description: string;
  stack: string;
  phase: "idea" | "mvp" | "polish" | "deploy";
  lastSessionId: string | null;
  githubRepo: string | null;
  netlifySiteUrl: string | null;
  dataSources?: string[];
  dismissedSuggestions?: string[];
  lastSyncedAt?: string | null;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  goal: string;
  whatChanged: string[];
  nextStep: string;
  blockers: string | null;
  detectedIntent?: string;
  suggestedNextStep?: string;
  createdAt: string;
}

export type DocItemCategory = "docs" | "ideas" | "plans";

export interface DocItem {
  id: string;
  category: DocItemCategory;
  filename: string;
  path: string;
  title: string;
  content: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface DevItem {
  id: string;
  filename: string;
  path: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface Prompt {
  id: string;
  title: string;
  body: string;
  scope: "global" | string; // "global" or a projectId
  projectId?: string | null;
  usageCount?: number;
  source?: "library" | "dev";
  devFilename?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptResponse {
  text: string;
  suggestedActions?: Array<{ tool: string; params: Record<string, unknown>; label: string }>;
  resolvedVariables?: Array<{ token: string; toolName: string; success: boolean }>;
  artifact?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolIntegration {
  id: string; // "github" | "notion"
  name: string;
  description: string;
  status: "connected" | "error" | "not_configured";
  tools: ToolDefinition[];
  configFields: { key: string; label: string; secret: boolean }[];
}

export interface ToolConfig {
  integrationId: string;
  values: Record<string, string>;
  enabled: boolean;
  updatedAt: string;
}

export interface LLMProvider {
  name: string;
  label: string;
  model: string;
}

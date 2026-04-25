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
  blockers: string | null;
  detectedIntent?: string;
  createdAt: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolIntegration {
  id: string; // "github"
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

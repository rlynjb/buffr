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

export type BuffrContextCategory = "context" | "rules" | "stack" | "agents";

export interface BuffrContextItem {
  id: string;
  projectId: string;
  filename: string;
  path: string;
  category: BuffrContextCategory;
  title: string;
  content: string;
  generatedAt: string;
  updatedAt: string;
}

export type BuffrGlobalCategory = "identity" | "rules" | "stack" | "skills";

export interface BuffrGlobalItem {
  id: string;
  filename: string;
  path: string;
  category: BuffrGlobalCategory;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type BuffrSpecCategory =
  | "features" | "bugs" | "tests" | "phases"
  | "migrations" | "refactors" | "prompts"
  | "performance" | "integrations";

export type BuffrSpecStatus = "draft" | "ready" | "in-progress" | "done";

export interface BuffrSpecItem {
  id: string;
  category: BuffrSpecCategory;
  filename: string;
  path: string;
  title: string;
  content: string;
  scope: string;
  status: BuffrSpecStatus;
  createdAt: string;
  updatedAt: string;
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

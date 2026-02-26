export interface Project {
  id: string;
  name: string;
  description: string;
  constraints: string;
  goals: string;
  stack: string;
  phase: "idea" | "mvp" | "polish" | "deploy";
  lastSessionId: string | null;
  githubRepo: string | null;
  repoVisibility: "public" | "private";
  netlifySiteId: string | null;
  netlifySiteUrl: string | null;
  plan: ProjectPlan | null;
  selectedFeatures: string[] | null;
  selectedFiles: string[] | null;
  dataSources?: string[];
  dismissedSuggestions?: string[];
  issueCount?: number;
  updatedAt: string;
}

export interface ProjectPlan {
  projectName: string;
  description: string;
  recommendedStack: string;
  features: PlanFeature[];
  deployChecklist: string[];
}

export interface PlanFeature {
  name: string;
  description: string;
  complexity: "simple" | "medium" | "complex";
  phase: 1 | 2;
  checked: boolean;
}

export interface Session {
  id: string;
  projectId: string;
  goal: string;
  whatChanged: string[];
  nextStep: string;
  blockers: string | null;
  aiSummary?: string;
  detectedIntent?: string;
  suggestedNextStep?: string;
  createdAt: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  url: string;
  source: string; // "github" | "notion" | "jira"
  labels?: string[];
  timestamp?: string;
}

export interface Prompt {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: "global" | string; // "global" or a projectId
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptResponse {
  text: string;
  suggestedActions?: Array<{ tool: string; params: Record<string, unknown>; label: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolIntegration {
  id: string; // "github" | "notion" | custom
  name: string;
  description: string;
  status: "connected" | "error" | "not_configured";
  tools: ToolDefinition[];
  configFields: { key: string; label: string; secret: boolean }[];
}

export interface ToolConfig {
  integrationId: string;
  values: Record<string, string>; // e.g. { token: "...", databaseId: "..." }
  enabled: boolean;
  updatedAt: string;
}

export interface CustomIntegration {
  id: string;
  name: string;
  description: string;
  configFields: { key: string; label: string; secret: boolean }[];
  createdAt: string;
}

export interface LLMProvider {
  name: string;
  label: string;
  model: string;
}


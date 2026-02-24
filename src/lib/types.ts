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
  createdAt: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
}

export interface Prompt {
  id: string;
  title: string;
  body: string;
  tags: string[];
  scope: "global" | string; // "global" or a projectId
  createdAt: string;
  updatedAt: string;
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

export interface GeneratePlanRequest {
  description: string;
  constraints: string;
  goals: string;
  provider: string;
  existingPlan?: ProjectPlan;
}

export interface GeneratePlanResponse {
  plan: ProjectPlan;
}

export interface ScaffoldRequest {
  projectName: string;
  description: string;
  stack: string;
  features: PlanFeature[];
  selectedFiles: string[];
  repoName: string;
  repoVisibility: "public" | "private";
  repoDescription: string;
  provider: string;
  constraints: string;
  goals: string;
}

export interface ScaffoldResponse {
  repoUrl: string;
  files: string[];
}

export interface DeployRequest {
  githubRepo: string;
  projectName: string;
}

export interface DeployResponse {
  siteId: string;
  siteUrl: string;
}

export const AVAILABLE_PROJECT_FILES = [
  "AI_RULES.md",
  "README.md",
  "ARCHITECTURE.md",
  "DEPLOYMENT.md",
  ".eslintrc.json",
  ".prettierrc",
  ".env.example",
  ".gitignore",
  ".editorconfig",
  "CONTRIBUTING.md",
  "LICENSE",
] as const;

export const DEFAULT_STACK = "Next.js + TypeScript + Tailwind CSS + Netlify";

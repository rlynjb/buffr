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
  githubIssuesSync?: boolean;
  dismissedSuggestions?: string[];
  issueCount?: number;
  devFolder?: DevFolder | null;
  techDebt?: TechDebtScan | null;
  updatedAt: string;
}

export type DevFolderStatus = "none" | "generated" | "stale";

export interface DevFolderGapScore {
  aligned: number;
  partial: number;
  gap: number;
}

export interface DevFolder {
  status: DevFolderStatus;
  lastScan: string | null;
  scanResultId: string | null;
  gapScore: DevFolderGapScore | null;
  adapters: string[];
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
  gitSnapshot?: {
    branch?: string;
    lastCommit?: string;
    changedFiles?: string[];
    dirty?: boolean;
  } | null;
  aiSummary?: string;
  detectedIntent?: string;
  suggestedNextStep?: string;
  linkedSessionIds?: string[];
  createdAt: string;
}

// .dev/ scan types

export interface ScanResultFile {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface DetectedPattern {
  category: string;
  pattern: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface TechDebtItem {
  type: string;
  file: string;
  line?: number;
  severity: "high" | "medium" | "low";
  text: string;
}

export interface TechDebtSummaryEntry {
  type: string;
  count: number;
  severity: "high" | "medium" | "low";
}

export interface TechDebtScan {
  items: TechDebtItem[];
  summary: TechDebtSummaryEntry[];
  scannedAt: string;
}

export interface GapAnalysisEntry {
  practice: string;
  industry: string;
  project: string;
  status: "aligned" | "partial" | "gap";
  category: string;
}

export interface ScanResult {
  id: string;
  projectId: string;
  repoFullName: string;
  status: "idle" | "scanning" | "analyzing" | "generating" | "done" | "failed";
  detectedStack: string[];
  fileTree: ScanResultFile[];
  parsedConfigs: { file: string; content: Record<string, unknown> }[];
  detectedPatterns: DetectedPattern[];
  techDebtItems: TechDebtItem[];
  gitActivity: { recentCommits: number; activePaths: string[]; lastCommitDate: string };
  generatedFiles: { path: string; content: string; ownership: string }[];
  gapAnalysis: GapAnalysisEntry[];
  detectedAdapters: string[];
  analysisSource?: "llm" | "rule-based" | "imported";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// Industry knowledge base types

export interface IndustryStandard {
  id: string;
  technology: string;
  version: string;
  title: string;
  content: string;
  sections: string[];
  sources: Array<{ label: string; url: string }>;
  updatedAt: string;
}

export interface IndustryKBMeta {
  technology: string;
  version: string;
  lastSeeded: string;
  entryCount: number;
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
  id: string; // "github" | "notion" | "jira"
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

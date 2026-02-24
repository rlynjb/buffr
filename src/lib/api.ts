import type {
  Project,
  Session,
  Prompt,
  LLMProvider,
  GitHubIssue,
  ToolIntegration,
  ToolConfig,
  CustomIntegration,
  GeneratePlanRequest,
  GeneratePlanResponse,
  ScaffoldRequest,
  ScaffoldResponse,
  DeployRequest,
  DeployResponse,
} from "./types";

const BASE = "/.netlify/functions";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text || `Request failed (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(
      (data.error as string) || `Request failed (${res.status})`
    );
  }
  return data as T;
}

// Projects
export async function listProjects(): Promise<Project[]> {
  return request<Project[]>("/projects");
}

export async function getProject(id: string): Promise<Project> {
  return request<Project>(`/projects?id=${encodeURIComponent(id)}`);
}

export async function createProject(
  data: Partial<Project>
): Promise<Project> {
  return request<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateProject(
  id: string,
  data: Partial<Project>
): Promise<Project> {
  return request<Project>(`/projects?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/projects?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Sessions
export async function listSessions(projectId: string): Promise<Session[]> {
  return request<Session[]>(
    `/sessions?projectId=${encodeURIComponent(projectId)}`
  );
}

export async function createSession(
  data: Partial<Session>
): Promise<Session> {
  return request<Session>("/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Providers
export async function getProviders(): Promise<{
  providers: LLMProvider[];
  defaultProvider: string;
}> {
  return request("/providers");
}

// Generate plan
export async function generatePlan(
  data: GeneratePlanRequest
): Promise<GeneratePlanResponse> {
  return request<GeneratePlanResponse>("/generate", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Scaffold
export async function scaffoldProject(
  data: ScaffoldRequest
): Promise<ScaffoldResponse & { githubRepo: string }> {
  return request("/scaffold", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Validate repo exists
export async function validateRepo(
  ownerRepo: string
): Promise<{
  name: string;
  description: string | null;
  defaultBranch: string;
  lastCommit: string;
}> {
  return request(`/scaffold?validate=${encodeURIComponent(ownerRepo)}`);
}

// Analyze repo
export async function analyzeRepo(
  ownerRepo: string
): Promise<{
  detectedStack: string;
  frameworks: string[];
  devTools: string[];
  hasTests: boolean;
  hasCI: boolean;
  hasDeployConfig: boolean;
  fileCount: number;
  detectedPhase: "idea" | "mvp" | "polish" | "deploy";
  issues: GitHubIssue[];
  issueCount: number;
}> {
  return request(`/scaffold?analyze=${encodeURIComponent(ownerRepo)}`);
}

// Fetch issues on-demand
export async function getIssues(
  ownerRepo: string
): Promise<GitHubIssue[]> {
  return request(`/scaffold?issues=${encodeURIComponent(ownerRepo)}`);
}

// List authenticated user's GitHub repos
export async function getUserRepos(): Promise<string[]> {
  return request("/scaffold?repos");
}

// Action Notes
export async function getActionNotes(
  projectId: string
): Promise<Record<string, string>> {
  return request(`/action-notes?projectId=${encodeURIComponent(projectId)}`);
}

export async function saveActionNote(
  projectId: string,
  actionId: string,
  note: string
): Promise<Record<string, string>> {
  return request(`/action-notes?projectId=${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify({ actionId, note }),
  });
}

// Prompts
export async function listPrompts(scope?: string): Promise<Prompt[]> {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return request<Prompt[]>(`/prompts${q}`);
}

export async function createPrompt(
  data: Partial<Prompt>
): Promise<Prompt> {
  return request<Prompt>("/prompts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updatePrompt(
  id: string,
  data: Partial<Prompt>
): Promise<Prompt> {
  return request<Prompt>(`/prompts?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deletePrompt(id: string): Promise<void> {
  await request(`/prompts?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Tools / Integrations
export async function listIntegrations(): Promise<ToolIntegration[]> {
  return request<ToolIntegration[]>("/tools");
}

export async function saveIntegrationConfig(
  integrationId: string,
  values: Record<string, string>,
  enabled: boolean
): Promise<ToolConfig> {
  return request<ToolConfig>(
    `/tools?integrationId=${encodeURIComponent(integrationId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ values, enabled }),
    }
  );
}

export async function createIntegration(data: {
  name: string;
  description: string;
  configFields: { key: string; label: string; secret: boolean }[];
}): Promise<CustomIntegration> {
  return request<CustomIntegration>("/tools?create", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function removeIntegration(integrationId: string): Promise<void> {
  await request(
    `/tools?integrationId=${encodeURIComponent(integrationId)}`,
    { method: "DELETE" }
  );
}

export async function executeToolAction(
  toolName: string,
  input: Record<string, unknown> = {}
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return request("/tools?execute", {
    method: "POST",
    body: JSON.stringify({ toolName, input }),
  });
}

// Deploy
export async function deployProject(
  data: DeployRequest
): Promise<DeployResponse & { buildId: string }> {
  return request("/deploy", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

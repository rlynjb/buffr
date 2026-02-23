import type {
  Project,
  Session,
  LLMProvider,
  GitHubIssue,
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

export async function getSession(id: string): Promise<Session> {
  return request<Session>(`/sessions?id=${encodeURIComponent(id)}`);
}

export async function createSession(
  data: Partial<Session>
): Promise<Session> {
  return request<Session>("/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/sessions?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
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

// Deploy
export async function deployProject(
  data: DeployRequest
): Promise<DeployResponse & { buildId: string }> {
  return request("/deploy", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

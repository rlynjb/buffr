import type {
  Project,
  Session,
  BuffrGlobalItem,
  BuffrSpecItem,
  BuffrContextItem,
  LLMProvider,
  ToolIntegration,
  ToolConfig,
} from "./types";

const BASE = "/.netlify/functions";

// Auth
export async function authCheck(): Promise<{ authenticated: boolean }> {
  const res = await fetch(`${BASE}/auth-check`);
  return res.json();
}

export async function login(
  username: string,
  password: string,
): Promise<void> {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Login failed");
  }
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/logout`, { method: "POST" });
}

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

// Manual Actions
export interface ManualActionData {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export async function listManualActions(
  projectId: string
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(`/manual-actions?projectId=${encodeURIComponent(projectId)}`);
}

export async function addManualAction(
  projectId: string,
  id: string,
  text: string
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(`/manual-actions?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: JSON.stringify({ id, text }),
  });
}

export async function updateManualAction(
  projectId: string,
  id: string,
  updates: { done?: boolean; text?: string }
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(`/manual-actions?projectId=${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify({ id, ...updates }),
  });
}

export async function reorderManualActions(
  projectId: string,
  orderedIds: string[]
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(`/manual-actions?projectId=${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ orderedIds }),
  });
}

export async function deleteManualAction(
  projectId: string,
  actionId: string
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(
    `/manual-actions?projectId=${encodeURIComponent(projectId)}&actionId=${encodeURIComponent(actionId)}`,
    { method: "DELETE" }
  );
}

export async function cleanDoneManualActions(
  projectId: string,
): Promise<ManualActionData[]> {
  return request<ManualActionData[]>(
    `/manual-actions?projectId=${encodeURIComponent(projectId)}&cleanDone`,
    { method: "DELETE" }
  );
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

// Default Data Sources
export async function getDefaultDataSources(): Promise<string[]> {
  const res = await request<{ sources: string[] }>("/tools?defaultSources");
  return res.sources;
}

export async function setDefaultDataSources(sources: string[]): Promise<void> {
  await request("/tools?defaultSources", {
    method: "PUT",
    body: JSON.stringify({ sources }),
  });
}

// Session AI
export async function summarizeSession(
  activityItems: Array<{ title: string; source: string; timestamp?: string }>,
  provider?: string,
): Promise<{ goal: string; bullets: string[] }> {
  return request("/session-ai?summarize", {
    method: "POST",
    body: JSON.stringify({ activityItems, provider }),
  });
}

export async function detectIntent(
  goal: string,
  whatChanged: string,
  projectPhase: string,
  provider?: string,
): Promise<{ intent: string }> {
  return request("/session-ai?intent", {
    method: "POST",
    body: JSON.stringify({ goal, whatChanged, projectPhase, provider }),
  });
}

export async function paraphraseText(
  text: string,
  provider?: string,
  persona?: string,
): Promise<{ text: string }> {
  return request("/session-ai?paraphrase", {
    method: "POST",
    body: JSON.stringify({ text, provider, persona }),
  });
}

// Buffr Context Items
export async function listBuffrContextItems(projectId: string): Promise<BuffrContextItem[]> {
  return request<BuffrContextItem[]>(`/buffr-context?projectId=${encodeURIComponent(projectId)}`);
}

export async function generateBuffrContext(
  projectId: string,
  provider?: string,
): Promise<BuffrContextItem> {
  return request<BuffrContextItem>("/buffr-context?generate", {
    method: "POST",
    body: JSON.stringify({ projectId, provider }),
  });
}

export async function updateBuffrContextItem(
  id: string,
  data: { content?: string; title?: string },
): Promise<BuffrContextItem> {
  return request<BuffrContextItem>(`/buffr-context?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function pushBuffrContextItems(
  projectId: string,
  repo: string,
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/buffr-context?push", {
    method: "POST",
    body: JSON.stringify({ projectId, repo }),
  });
}

// Buffr Global Items
export async function listBuffrGlobalItems(): Promise<BuffrGlobalItem[]> {
  return request<BuffrGlobalItem[]>("/buffr-global");
}

export async function createBuffrGlobalItem(
  data: Partial<BuffrGlobalItem>,
): Promise<BuffrGlobalItem> {
  return request<BuffrGlobalItem>("/buffr-global", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateBuffrGlobalItem(
  id: string,
  data: Partial<BuffrGlobalItem>,
): Promise<BuffrGlobalItem> {
  return request<BuffrGlobalItem>(`/buffr-global?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteBuffrGlobalItemApi(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/buffr-global?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function pushBuffrGlobalItems(
  repo: string,
  adapterIds?: string[],
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/buffr-global?push", {
    method: "POST",
    body: JSON.stringify({ repo, adapterIds }),
  });
}

// Buffr Spec Items
export async function listBuffrSpecItems(projectId: string): Promise<BuffrSpecItem[]> {
  return request<BuffrSpecItem[]>(`/buffr-specs?scope=${encodeURIComponent(projectId)}`);
}

export async function createBuffrSpecItem(
  data: Partial<BuffrSpecItem>,
): Promise<BuffrSpecItem> {
  return request<BuffrSpecItem>("/buffr-specs", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateBuffrSpecItem(
  id: string,
  data: Partial<BuffrSpecItem>,
): Promise<BuffrSpecItem> {
  return request<BuffrSpecItem>(`/buffr-specs?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteBuffrSpecItemApi(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/buffr-specs?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function pushBuffrSpecItems(
  projectId: string,
  repo: string,
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/buffr-specs?push", {
    method: "POST",
    body: JSON.stringify({ projectId, repo }),
  });
}

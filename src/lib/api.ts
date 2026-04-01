import type {
  Project,
  Session,
  Prompt,
  DevItem,
  DocItem,
  LLMProvider,
  ToolIntegration,
  ToolConfig,
  PromptResponse,
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

// Manual Actions
export interface ManualActionData {
  id: string;
  text: string;
  done: boolean;
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

export async function suggestNextStep(
  goal: string,
  whatChanged: string,
  currentNextStep?: string,
  projectContext?: string,
  openItems?: string,
  provider?: string,
): Promise<{ suggestedNextStep: string }> {
  return request("/session-ai?suggest", {
    method: "POST",
    body: JSON.stringify({ goal, whatChanged, currentNextStep, projectContext, openItems, provider }),
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

// Run Prompt
export async function runPrompt(
  promptId: string,
  projectId?: string,
  provider?: string,
): Promise<PromptResponse> {
  return request<PromptResponse>("/run-prompt", {
    method: "POST",
    body: JSON.stringify({ promptId, projectId, provider }),
  });
}

// Dev Items
export async function listDevItems(): Promise<DevItem[]> {
  return request<DevItem[]>("/dev-items");
}

export async function createDevItem(
  data: Partial<DevItem>,
): Promise<DevItem> {
  return request<DevItem>("/dev-items", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateDevItem(
  id: string,
  data: Partial<DevItem>,
): Promise<DevItem> {
  return request<DevItem>(`/dev-items?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteDevItemApi(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/dev-items?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function pushDevItems(
  repo: string,
  adapterIds?: string[],
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/dev-items?push", {
    method: "POST",
    body: JSON.stringify({ repo, adapterIds }),
  });
}

// Doc Items
export async function listDocItems(scope?: string): Promise<DocItem[]> {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return request<DocItem[]>(`/doc-items${q}`);
}

export async function createDocItem(
  data: Partial<DocItem>,
): Promise<DocItem> {
  return request<DocItem>("/doc-items", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateDocItem(
  id: string,
  data: Partial<DocItem>,
): Promise<DocItem> {
  return request<DocItem>(`/doc-items?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteDocItemApi(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/doc-items?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function pushDocItems(
  projectId: string,
  repo: string,
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/doc-items?push", {
    method: "POST",
    body: JSON.stringify({ projectId, repo }),
  });
}

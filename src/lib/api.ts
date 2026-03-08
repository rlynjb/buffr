import type {
  Project,
  Session,
  Prompt,
  LLMProvider,
  ToolIntegration,
  ToolConfig,
  PromptResponse,
  ScanResult,
  IndustryStandard,
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

// Scan Results
export async function getScanResult(id: string): Promise<ScanResult> {
  return request<ScanResult>(`/scan-results?id=${encodeURIComponent(id)}`);
}

export async function listScanResults(projectId: string): Promise<ScanResult[]> {
  return request<ScanResult[]>(`/scan-results?projectId=${encodeURIComponent(projectId)}`);
}

export async function updateScanResult(
  id: string,
  updates: Partial<Pick<ScanResult, "generatedFiles" | "detectedAdapters">>,
): Promise<ScanResult> {
  return request<ScanResult>(`/scan-results?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

// Industry KB
export async function listStandards(): Promise<IndustryStandard[]> {
  return request<IndustryStandard[]>("/industry-kb");
}

export async function getStandard(technology: string): Promise<IndustryStandard> {
  return request<IndustryStandard>(`/industry-kb?technology=${encodeURIComponent(technology)}`);
}

export async function seedIndustryKB(force = false): Promise<{ seeded: string[]; skipped: string[] }> {
  return request("/industry-kb?seed", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

// Trigger scan / generate .dev/
export async function triggerScan(projectId: string, provider?: string, skipPush?: boolean): Promise<ScanResult> {
  return request<ScanResult>("/generate-dev", {
    method: "POST",
    body: JSON.stringify({ projectId, provider, skipPush }),
  });
}

// Detect existing .dev/ folder in repo
export async function detectDevFolder(projectId: string): Promise<ScanResult | null> {
  const res = await request<ScanResult | { detected: false }>("/detect-dev", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
  if ("detected" in res && res.detected === false) return null;
  return res as ScanResult;
}

// Push .dev/ files to GitHub repo
export async function pushDevFiles(
  scanResultId: string
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/generate-dev?push", {
    method: "POST",
    body: JSON.stringify({ scanResultId }),
  });
}

// Install adapter symlink at repo root
export async function installAdapter(
  scanResultId: string,
  adapterPath: string,
  rootPath: string,
): Promise<{ sha: string }> {
  return request<{ sha: string }>("/generate-dev?install-adapter", {
    method: "POST",
    body: JSON.stringify({ scanResultId, adapterPath, rootPath }),
  });
}

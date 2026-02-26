import { listToolConfigs } from "./storage/tool-config";
import type { WorkItem } from "../../../src/lib/types";

interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

async function getJiraCredentials(): Promise<JiraCredentials> {
  const configs = await listToolConfigs();
  const jiraConfig = configs.find((c) => c.integrationId === "jira");

  const baseUrl = jiraConfig?.values?.baseUrl || process.env.JIRA_BASE_URL;
  const email = jiraConfig?.values?.email || process.env.JIRA_EMAIL;
  const apiToken = jiraConfig?.values?.apiToken || process.env.JIRA_API_TOKEN;
  const projectKey = jiraConfig?.values?.projectKey || process.env.JIRA_PROJECT_KEY;

  if (!baseUrl || !email || !apiToken) {
    throw new Error("Jira integration not configured. Add credentials via the Tools page or set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.");
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), email, apiToken, projectKey: projectKey || "" };
}

async function jiraFetch(
  creds: JiraCredentials,
  path: string,
  options: RequestInit = {},
): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const res = await fetch(`${creds.baseUrl}/rest/api/3${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const d = data as Record<string, unknown>;
    const messages = (d.errorMessages as string[]) || [];
    throw new Error(messages[0] || `Jira API error (${res.status})`);
  }

  return data as Record<string, unknown>;
}

function issueToWorkItem(issue: Record<string, unknown>): WorkItem {
  const fields = issue.fields as Record<string, unknown> | undefined;
  const status = fields?.status as Record<string, unknown> | undefined;
  const labels = (fields?.labels || []) as string[];

  return {
    id: issue.key as string,
    title: (fields?.summary as string) || "Untitled",
    status: (status?.name as string) || "unknown",
    url: `${(issue.self as string || "").split("/rest/")[0]}/browse/${issue.key}`,
    source: "jira",
    labels,
    timestamp: (fields?.created as string) || undefined,
  };
}

export async function searchIssues(
  projectKey?: string,
  jql?: string,
  since?: string,
): Promise<WorkItem[]> {
  const creds = await getJiraCredentials();
  const key = projectKey || creds.projectKey;

  let query = jql || "";
  if (!query && key) {
    query = `project = "${key}" AND statusCategory != Done ORDER BY created DESC`;
  }
  if (since && !jql) {
    query = `project = "${key}" AND created >= "${since}" AND statusCategory != Done ORDER BY created DESC`;
  }

  const data = await jiraFetch(creds, `/search?jql=${encodeURIComponent(query)}&maxResults=20&fields=summary,status,labels,created`);
  const issues = (data.issues || []) as Array<Record<string, unknown>>;
  return issues.map(issueToWorkItem);
}

export async function searchResolvedIssues(
  projectKey?: string,
  since?: string,
): Promise<WorkItem[]> {
  const creds = await getJiraCredentials();
  const key = projectKey || creds.projectKey;
  if (!key) throw new Error("Jira project key required");

  let query = `project = "${key}" AND statusCategory = Done ORDER BY updated DESC`;
  if (since) {
    query = `project = "${key}" AND statusCategory = Done AND updated >= "${since}" ORDER BY updated DESC`;
  }

  const data = await jiraFetch(creds, `/search?jql=${encodeURIComponent(query)}&maxResults=20&fields=summary,status,labels,created`);
  const issues = (data.issues || []) as Array<Record<string, unknown>>;
  return issues.map(issueToWorkItem);
}

export async function getIssue(issueKey: string): Promise<WorkItem> {
  const creds = await getJiraCredentials();
  const data = await jiraFetch(creds, `/issue/${encodeURIComponent(issueKey)}?fields=summary,status,labels,created`);
  return issueToWorkItem(data);
}

export async function createIssue(
  projectKey?: string,
  summary?: string,
  description?: string,
  issueType?: string,
  labels?: string[],
): Promise<WorkItem> {
  const creds = await getJiraCredentials();
  const key = projectKey || creds.projectKey;
  if (!key) throw new Error("Jira project key required");
  if (!summary) throw new Error("Issue summary required");

  const fields: Record<string, unknown> = {
    project: { key },
    summary,
    issuetype: { name: issueType || "Task" },
  };
  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }
  if (labels && labels.length > 0) {
    fields.labels = labels;
  }

  const data = await jiraFetch(creds, "/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });

  return {
    id: data.key as string,
    title: summary,
    status: "To Do",
    url: `${creds.baseUrl}/browse/${data.key}`,
    source: "jira",
    labels,
  };
}

export async function transitionIssue(
  issueKey: string,
  transitionName: string,
): Promise<void> {
  const creds = await getJiraCredentials();

  // Get available transitions
  const transData = await jiraFetch(creds, `/issue/${encodeURIComponent(issueKey)}/transitions`);
  const transitions = (transData.transitions || []) as Array<{ id: string; name: string }>;
  const match = transitions.find(
    (t) => t.name.toLowerCase() === transitionName.toLowerCase(),
  );

  if (!match) {
    const available = transitions.map((t) => t.name).join(", ");
    throw new Error(`Transition "${transitionName}" not found. Available: ${available}`);
  }

  await jiraFetch(creds, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
}

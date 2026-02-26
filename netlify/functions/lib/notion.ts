import { listToolConfigs } from "./storage/tool-config";
import type { WorkItem } from "../../../src/lib/types";

const API = "https://api.notion.com/v1";

async function getToken(): Promise<string> {
  const configs = await listToolConfigs();
  const notionConfig = configs.find((c) => c.integrationId === "notion");
  const token = notionConfig?.values?.token || process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion integration not configured. Add a Notion token via the Tools page or set NOTION_TOKEN.");
  return token;
}

function getDatabaseId(input?: string): string {
  const id = input || process.env.NOTION_DATABASE_ID;
  if (!id) throw new Error("Notion database ID not configured. Set NOTION_DATABASE_ID or pass databaseId.");
  return id;
}

async function notionFetch(
  path: string,
  options: RequestInit = {},
): Promise<Record<string, unknown>> {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const d = data as Record<string, unknown>;
    throw new Error((d.message as string) || `Notion API error (${res.status})`);
  }

  return data as Record<string, unknown>;
}

function pageToWorkItem(page: Record<string, unknown>): WorkItem {
  const props = page.properties as Record<string, Record<string, unknown>> | undefined;
  const titleProp = props
    ? Object.values(props).find((p) => p.type === "title")
    : undefined;
  const titleArr = titleProp?.title as Array<{ plain_text: string }> | undefined;
  const title = titleArr?.[0]?.plain_text || "Untitled";

  const statusProp = props
    ? Object.values(props).find((p) => p.type === "status" || p.type === "select")
    : undefined;
  const statusVal = statusProp?.status || statusProp?.select;
  const status = (statusVal as Record<string, unknown>)?.name as string || "open";

  return {
    id: (page.id as string).replace(/-/g, ""),
    title,
    status,
    url: (page.url as string) || "",
    source: "notion",
    timestamp: (page.created_time as string) || undefined,
  };
}

export async function queryTasks(
  databaseId?: string,
  filter?: Record<string, unknown>,
): Promise<WorkItem[]> {
  const dbId = getDatabaseId(databaseId);
  const body: Record<string, unknown> = { page_size: 20 };
  if (filter) body.filter = filter;

  const data = await notionFetch(`/databases/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const results = (data.results || []) as Array<Record<string, unknown>>;
  return results.map(pageToWorkItem);
}

export async function getTask(pageId: string): Promise<WorkItem> {
  const data = await notionFetch(`/pages/${pageId}`);
  return pageToWorkItem(data);
}

export async function createTask(
  databaseId?: string,
  title?: string,
  status?: string,
): Promise<WorkItem> {
  const dbId = getDatabaseId(databaseId);
  const properties: Record<string, unknown> = {};

  if (title) {
    properties["Name"] = {
      title: [{ text: { content: title } }],
    };
  }
  if (status) {
    properties["Status"] = {
      status: { name: status },
    };
  }

  const data = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
    }),
  });

  return pageToWorkItem(data);
}

export async function updateTask(
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

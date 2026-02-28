import type { GitHubIssue, WorkItem } from "./types";

/**
 * Maps integration IDs to capabilities and their corresponding tool names.
 * Features call getToolForCapability() to find the right tool, then
 * execute it via executeToolAction() from the API layer.
 */
const DATA_SOURCE_TOOLS: Record<string, Record<string, string>> = {
  github: {
    list_open_items: "github_list_issues",
    list_recent_activity: "github_list_issues",
    create_item: "github_create_issue",
    close_item: "github_close_issue",
    list_commits: "github_list_commits",
    get_diffs: "github_get_diffs",
    get_file: "github_get_file",
  },
  notion: {
    list_open_items: "notion_list_tasks",
    list_recent_activity: "notion_list_tasks",
    create_item: "notion_create_task",
    close_item: "notion_update_task",
  },
  jira: {
    list_open_items: "jira_list_issues",
    list_recent_activity: "jira_list_resolved",
    create_item: "jira_create_issue",
    close_item: "jira_transition_issue",
  },
};

export function getToolForCapability(
  integrationId: string,
  capability: string,
): string | null {
  return DATA_SOURCE_TOOLS[integrationId]?.[capability] ?? null;
}

export function getIntegrationsWithCapability(capability: string): string[] {
  return Object.entries(DATA_SOURCE_TOOLS)
    .filter(([, caps]) => capability in caps)
    .map(([id]) => id);
}

export function mapGitHubIssuesToWorkItems(issues: GitHubIssue[]): WorkItem[] {
  return issues.map((issue) => ({
    id: String(issue.number),
    title: issue.title,
    status: "open",
    url: issue.url,
    source: "github",
    labels: issue.labels,
    timestamp: issue.createdAt,
  }));
}

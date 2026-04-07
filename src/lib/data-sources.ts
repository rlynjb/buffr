/**
 * Maps integration IDs to capabilities and their corresponding tool names.
 * Features call getToolForCapability() to find the right tool, then
 * execute it via executeToolAction() from the API layer.
 */
const DATA_SOURCE_TOOLS: Record<string, Record<string, string>> = {
  github: {
    list_recent_activity: "github_list_issues",
    create_item: "github_create_issue",
    close_item: "github_close_issue",
    list_commits: "github_list_commits",
    get_diffs: "github_get_diffs",
    get_file: "github_get_file",
  },
};

export function getToolForCapability(
  integrationId: string,
  capability: string,
): string | null {
  return DATA_SOURCE_TOOLS[integrationId]?.[capability] ?? null;
}



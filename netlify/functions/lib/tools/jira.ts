import { registerTool } from "./registry";
import {
  searchIssues,
  searchResolvedIssues,
  getIssue,
  createIssue,
  transitionIssue,
} from "../jira";

const INTEGRATION_ID = "jira";

export function registerJiraTools() {
  registerTool({
    name: "jira_list_issues",
    description: "List open issues for a Jira project",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key (uses default if omitted)" },
        jql: { type: "string", description: "Custom JQL query (optional)" },
        since: { type: "string", description: "ISO timestamp to filter issues created after" },
      },
    },
    execute: async (input) => {
      const items = await searchIssues(
        input.projectKey as string | undefined,
        input.jql as string | undefined,
        input.since as string | undefined,
      );
      return { items };
    },
  });

  registerTool({
    name: "jira_list_resolved",
    description: "List recently resolved issues for a Jira project",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key (uses default if omitted)" },
        since: { type: "string", description: "ISO timestamp to filter issues resolved after" },
      },
    },
    execute: async (input) => {
      const items = await searchResolvedIssues(
        input.projectKey as string | undefined,
        input.since as string | undefined,
      );
      return { items };
    },
  });

  registerTool({
    name: "jira_get_issue",
    description: "Get a single Jira issue by key",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "Issue key (e.g. PROJ-123)" },
      },
      required: ["issueKey"],
    },
    execute: async (input) => {
      return getIssue(input.issueKey as string);
    },
  });

  registerTool({
    name: "jira_create_issue",
    description: "Create a new issue in a Jira project",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key (uses default if omitted)" },
        summary: { type: "string", description: "Issue summary/title" },
        description: { type: "string", description: "Issue description" },
        issueType: { type: "string", description: "Issue type (default: Task)" },
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
      },
      required: ["summary"],
    },
    execute: async (input) => {
      return createIssue(
        input.projectKey as string | undefined,
        input.summary as string,
        input.description as string | undefined,
        input.issueType as string | undefined,
        input.labels as string[] | undefined,
      );
    },
  });

  registerTool({
    name: "jira_transition_issue",
    description: "Transition a Jira issue to a new status (e.g. 'Done', 'In Progress')",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "Issue key (e.g. PROJ-123)" },
        transition: { type: "string", description: "Target transition name (e.g. 'Done')" },
      },
      required: ["issueKey", "transition"],
    },
    execute: async (input) => {
      await transitionIssue(
        input.issueKey as string,
        input.transition as string,
      );
      return { ok: true };
    },
  });
}

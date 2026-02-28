import { registerTool } from "./registry";
import {
  getRepoInfo,
  getIssues,
  getUserRepos,
  analyzeRepo,
  createRepo,
  pushFiles,
  createIssue,
  closeIssue,
  getCommits,
  getDiffs,
  getFileContent,
} from "../github";

const INTEGRATION_ID = "github";

export function registerGitHubTools() {
  registerTool({
    name: "github_get_repo",
    description: "Get repository metadata (name, description, default branch, last commit)",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        ownerRepo: { type: "string", description: "owner/repo format" },
      },
      required: ["ownerRepo"],
    },
    execute: async (input) => {
      const info = await getRepoInfo(input.ownerRepo as string);
      if (!info) throw new Error("Repository not found");
      return info;
    },
  });

  registerTool({
    name: "github_list_issues",
    description: "List open issues for a repository (excludes pull requests)",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        limit: { type: "number", description: "Max issues to return (default 10)" },
      },
      required: ["owner", "repo"],
    },
    execute: async (input) => {
      const raw = await getIssues(
        input.owner as string,
        input.repo as string,
        (input.limit as number) || 10,
      );
      return {
        items: raw.map((issue) => ({
          id: String(issue.number),
          title: issue.title,
          status: "open",
          url: issue.url,
          source: "github",
          labels: issue.labels,
          timestamp: issue.createdAt,
        })),
      };
    },
  });

  registerTool({
    name: "github_list_repos",
    description: "List all repositories for the authenticated GitHub user",
    integrationId: INTEGRATION_ID,
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      return getUserRepos();
    },
  });

  registerTool({
    name: "github_analyze_repo",
    description: "Analyze a repository's stack, frameworks, dev tools, phase, and maturity signals",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string", description: "Branch to analyze (default: main)" },
      },
      required: ["owner", "repo"],
    },
    execute: async (input) => {
      const owner = input.owner as string;
      const repo = input.repo as string;
      const info = await getRepoInfo(`${owner}/${repo}`);
      const branch = (input.branch as string) || info?.defaultBranch || "main";
      const analysis = await analyzeRepo(owner, repo, branch);
      return {
        ...analysis,
        description: info?.description || null,
        defaultBranch: branch,
      };
    },
  });

  registerTool({
    name: "github_create_repo",
    description: "Create a new GitHub repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        isPrivate: { type: "boolean" },
      },
      required: ["name"],
    },
    execute: async (input) => {
      return createRepo(
        input.name as string,
        (input.description as string) || "",
        (input.isPrivate as boolean) || false
      );
    },
  });

  registerTool({
    name: "github_push_files",
    description: "Push files to a GitHub repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
        message: { type: "string" },
      },
      required: ["owner", "repo", "files", "message"],
    },
    execute: async (input) => {
      const sha = await pushFiles(
        input.owner as string,
        input.repo as string,
        input.files as Array<{ path: string; content: string }>,
        input.message as string
      );
      return { sha };
    },
  });

  registerTool({
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["owner", "repo", "title"],
    },
    execute: async (input) => {
      return createIssue(
        input.owner as string,
        input.repo as string,
        input.title as string,
        (input.body as string) || undefined,
        (input.labels as string[]) || undefined,
      );
    },
  });

  registerTool({
    name: "github_close_issue",
    description: "Close an issue in a GitHub repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issueNumber: { type: "number" },
      },
      required: ["owner", "repo", "issueNumber"],
    },
    execute: async (input) => {
      await closeIssue(
        input.owner as string,
        input.repo as string,
        input.issueNumber as number,
      );
      return { ok: true };
    },
  });

  registerTool({
    name: "github_list_commits",
    description: "List recent commits for a repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        since: { type: "string", description: "ISO timestamp to filter commits after" },
        limit: { type: "number", description: "Max commits to return (default 30)" },
      },
      required: ["owner", "repo"],
    },
    execute: async (input) => {
      return getCommits(
        input.owner as string,
        input.repo as string,
        (input.since as string) || undefined,
        (input.limit as number) || 30,
      );
    },
  });

  registerTool({
    name: "github_get_diffs",
    description: "Get code diffs between two refs in a repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        base: { type: "string", description: "Base ref (commit SHA, branch name)" },
        head: { type: "string", description: "Head ref (default: HEAD)" },
      },
      required: ["owner", "repo", "base"],
    },
    execute: async (input) => {
      return getDiffs(
        input.owner as string,
        input.repo as string,
        input.base as string,
        (input.head as string) || "HEAD",
      );
    },
  });

  registerTool({
    name: "github_get_file",
    description: "Read a single file's contents from a GitHub repository",
    integrationId: INTEGRATION_ID,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "File path in the repo (e.g. CHANGELOG.md)" },
        branch: { type: "string", description: "Branch name (optional, defaults to main)" },
      },
      required: ["owner", "repo", "path"],
    },
    execute: async (input) => {
      const content = await getFileContent(
        input.owner as string,
        input.repo as string,
        input.path as string,
        (input.branch as string) || undefined,
      );
      if (content === null) {
        throw new Error(`File not found: ${input.path}`);
      }
      return { content, path: input.path };
    },
  });
}

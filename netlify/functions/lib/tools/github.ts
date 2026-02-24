import { registerTool } from "./registry";
import {
  getRepoInfo,
  getIssues,
  getUserRepos,
  analyzeRepo,
  createRepo,
  pushFiles,
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
      return getIssues(
        input.owner as string,
        input.repo as string,
        (input.limit as number) || 10
      );
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
      return analyzeRepo(
        input.owner as string,
        input.repo as string,
        (input.branch as string) || "main"
      );
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
}

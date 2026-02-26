import { describe, it, expect } from "vitest";
import { getToolForCapability, getIntegrationsWithCapability, mapGitHubIssuesToWorkItems } from "./data-sources";
import type { GitHubIssue } from "./types";

describe("getToolForCapability", () => {
  it("returns the correct tool for github list_open_items", () => {
    expect(getToolForCapability("github", "list_open_items")).toBe("github_list_issues");
  });

  it("returns the correct tool for notion create_item", () => {
    expect(getToolForCapability("notion", "create_item")).toBe("notion_create_task");
  });

  it("returns the correct tool for jira close_item", () => {
    expect(getToolForCapability("jira", "close_item")).toBe("jira_transition_issue");
  });

  it("returns null for unknown integration", () => {
    expect(getToolForCapability("slack", "list_open_items")).toBeNull();
  });

  it("returns null for unknown capability", () => {
    expect(getToolForCapability("github", "unknown_capability")).toBeNull();
  });
});

describe("getIntegrationsWithCapability", () => {
  it("returns all integrations with list_open_items", () => {
    const result = getIntegrationsWithCapability("list_open_items");
    expect(result).toContain("github");
    expect(result).toContain("notion");
    expect(result).toContain("jira");
    expect(result).toHaveLength(3);
  });

  it("returns only github for list_commits", () => {
    const result = getIntegrationsWithCapability("list_commits");
    expect(result).toEqual(["github"]);
  });

  it("returns empty array for unknown capability", () => {
    expect(getIntegrationsWithCapability("nonexistent")).toEqual([]);
  });
});

describe("mapGitHubIssuesToWorkItems", () => {
  it("maps GitHub issues to WorkItem shape", () => {
    const issues: GitHubIssue[] = [
      { number: 42, title: "Fix login", url: "https://github.com/o/r/issues/42", labels: ["bug"], createdAt: "2024-01-01T00:00:00Z" },
    ];
    const items = mapGitHubIssuesToWorkItems(issues);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "42",
      title: "Fix login",
      status: "open",
      url: "https://github.com/o/r/issues/42",
      source: "github",
      labels: ["bug"],
      timestamp: "2024-01-01T00:00:00Z",
    });
  });

  it("handles empty array", () => {
    expect(mapGitHubIssuesToWorkItems([])).toEqual([]);
  });
});

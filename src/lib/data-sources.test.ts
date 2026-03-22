import { describe, it, expect } from "vitest";
import { getToolForCapability } from "./data-sources";

describe("getToolForCapability", () => {
  it("returns the correct tool for github list_recent_activity", () => {
    expect(getToolForCapability("github", "list_recent_activity")).toBe("github_list_issues");
  });

  it("returns the correct tool for notion create_item", () => {
    expect(getToolForCapability("notion", "create_item")).toBe("notion_create_task");
  });

  it("returns null for unknown integration", () => {
    expect(getToolForCapability("slack", "list_recent_activity")).toBeNull();
  });

  it("returns null for unknown capability", () => {
    expect(getToolForCapability("github", "unknown_capability")).toBeNull();
  });
});


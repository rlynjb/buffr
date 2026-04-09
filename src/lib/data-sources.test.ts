import { describe, it, expect } from "vitest";
import { getToolForCapability } from "./data-sources";

describe("getToolForCapability", () => {
  it("returns the correct tool for github create_item", () => {
    expect(getToolForCapability("github", "create_item")).toBe("github_create_issue");
  });

  it("returns null for unknown integration", () => {
    expect(getToolForCapability("slack", "create_item")).toBeNull();
  });

  it("returns null for unknown capability", () => {
    expect(getToolForCapability("github", "unknown_capability")).toBeNull();
  });
});

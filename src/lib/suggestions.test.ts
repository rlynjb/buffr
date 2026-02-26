import { describe, it, expect } from "vitest";
import { generateSuggestions } from "./suggestions";
import type { Project, Session } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Test",
    description: "",
    constraints: "",
    goals: "",
    stack: "Next.js",
    phase: "mvp",
    lastSessionId: null,
    githubRepo: null,
    repoVisibility: "private",
    netlifySiteId: null,
    netlifySiteUrl: null,
    plan: null,
    selectedFeatures: null,
    selectedFiles: null,
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("generateSuggestions", () => {
  it("suggests connecting a source when dataSources is empty", () => {
    const project = makeProject({ dataSources: [] });
    const suggestions = generateSuggestions(project, null, ["github"]);
    expect(suggestions.some((s) => s.id === "connect-source")).toBe(true);
  });

  it("does not suggest connecting a source when no integrations connected", () => {
    const project = makeProject({ dataSources: [] });
    const suggestions = generateSuggestions(project, null, []);
    expect(suggestions.some((s) => s.id === "connect-source")).toBe(false);
  });

  it("suggests first session when no session exists", () => {
    const project = makeProject();
    const suggestions = generateSuggestions(project, null, []);
    expect(suggestions.some((s) => s.id === "first-session")).toBe(true);
  });

  it("suggests resuming when idle > 14 days", () => {
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const session: Session = {
      id: "s1",
      projectId: "p1",
      goal: "Work",
      whatChanged: [],
      nextStep: "",
      blockers: null,
      createdAt: oldDate,
    };
    const project = makeProject({ lastSessionId: "s1" });
    const suggestions = generateSuggestions(project, session, []);
    expect(suggestions.some((s) => s.id === "idle-project")).toBe(true);
  });

  it("filters dismissed suggestions", () => {
    const project = makeProject({ dismissedSuggestions: ["first-session", "add-prompts"] });
    const suggestions = generateSuggestions(project, null, []);
    expect(suggestions.some((s) => s.id === "first-session")).toBe(false);
    expect(suggestions.some((s) => s.id === "add-prompts")).toBe(false);
  });

  it("limits to 2 suggestions", () => {
    const project = makeProject({ dataSources: [] });
    const suggestions = generateSuggestions(project, null, ["github", "notion"]);
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });
});

import { describe, it, expect } from "vitest";
import { resolvePrompt } from "./resolve-prompt";
import type { Project, Session, WorkItem } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "MyApp",
    description: "A cool app",
    constraints: "Must be fast",
    goals: "Launch MVP",
    stack: "Next.js + TypeScript",
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

describe("resolvePrompt", () => {
  it("resolves project variables", () => {
    const result = resolvePrompt("Build {{project.name}} with {{project.stack}}", {
      project: makeProject(),
    });
    expect(result).toBe("Build MyApp with Next.js + TypeScript");
  });

  it("resolves session variables", () => {
    const session: Session = {
      id: "s1",
      projectId: "p1",
      goal: "Add auth",
      whatChanged: [],
      nextStep: "Add logout",
      blockers: "Waiting on API",
      createdAt: "2024-01-01T00:00:00Z",
    };
    const result = resolvePrompt("Goal: {{lastSession.goal}}, Next: {{lastSession.nextStep}}", {
      lastSession: session,
    });
    expect(result).toBe("Goal: Add auth, Next: Add logout");
  });

  it("resolves issues variable with WorkItem data", () => {
    const items: WorkItem[] = [
      { id: "42", title: "Fix login", status: "open", url: "", source: "github" },
      { id: "43", title: "Add tests", status: "open", url: "", source: "notion" },
    ];
    const result = resolvePrompt("Issues:\n{{issues}}", { issues: items });
    expect(result).toContain("#42: Fix login");
    expect(result).toContain("#43: Add tests");
  });

  it("replaces unknown variables with empty strings", () => {
    const result = resolvePrompt("Hello {{unknown}}", {});
    expect(result).toBe("Hello ");
  });

  it("handles empty context", () => {
    const result = resolvePrompt("No vars here", {});
    expect(result).toBe("No vars here");
  });

  it("handles missing project gracefully", () => {
    const result = resolvePrompt("{{project.name}} app", { project: null });
    expect(result).toBe(" app");
  });
});

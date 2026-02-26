import { describe, it, expect } from "vitest";
import { generateNextActions, type ActionContext } from "./next-actions";
import type { Project, Session, WorkItem } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Test Project",
    description: "desc",
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    goal: "Implement auth",
    whatChanged: ["Added login"],
    nextStep: "Add logout",
    blockers: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("generateNextActions", () => {
  it("returns session action when lastSession has nextStep", () => {
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: makeSession({ nextStep: "Add logout" }),
    };
    const actions = generateNextActions(ctx);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].text).toBe("Add logout");
    expect(actions[0].source).toBe("session");
  });

  it("returns AI action at top priority", () => {
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: makeSession({
        suggestedNextStep: "Write tests for auth",
        nextStep: "Add logout",
      }),
    };
    const actions = generateNextActions(ctx);
    expect(actions[0].source).toBe("ai");
    expect(actions[0].text).toBe("Write tests for auth");
  });

  it("returns activity action when idle > 7 days", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: makeSession({ createdAt: oldDate, nextStep: "" }),
    };
    const actions = generateNextActions(ctx);
    expect(actions.some((a) => a.source === "activity")).toBe(true);
  });

  it("returns work item actions", () => {
    const items: WorkItem[] = [
      { id: "1", title: "Bug fix", status: "open", url: "", source: "github" },
      { id: "2", title: "Feature", status: "open", url: "", source: "notion" },
    ];
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: null,
      workItems: items,
    };
    const actions = generateNextActions(ctx);
    expect(actions.some((a) => a.source === "issue")).toBe(true);
  });

  it("limits to 3 actions", () => {
    const items: WorkItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      title: `Item ${i}`,
      status: "open",
      url: "",
      source: "github",
    }));
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: makeSession(),
      workItems: items,
    };
    const actions = generateNextActions(ctx);
    expect(actions.length).toBeLessThanOrEqual(3);
  });

  it("deduplicates by id", () => {
    const ctx: ActionContext = {
      project: makeProject(),
      lastSession: makeSession({ nextStep: "Fix #1: Bug" }),
      workItems: [{ id: "1", title: "Bug", status: "open", url: "", source: "github" }],
    };
    const actions = generateNextActions(ctx);
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

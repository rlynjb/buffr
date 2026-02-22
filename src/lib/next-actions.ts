import type { Project, Session, GitHubIssue } from "./types";

export interface NextAction {
  id: string;
  text: string;
  done: boolean;
  skipped: boolean;
  source?: "session" | "activity" | "issue" | "stack" | "phase";
}

export interface ActionContext {
  project: Project;
  lastSession: Session | null;
  issues?: GitHubIssue[];
}

// --- Action source functions (priority order) ---

function actionsFromSession(ctx: ActionContext): NextAction[] {
  if (!ctx.lastSession?.nextStep) return [];
  return [
    {
      id: `session-${ctx.lastSession.id}`,
      text: ctx.lastSession.nextStep,
      done: false,
      skipped: false,
      source: "session",
    },
  ];
}

function actionsFromActivity(ctx: ActionContext): NextAction[] {
  if (!ctx.lastSession) return [];
  const daysSince = Math.floor(
    (Date.now() - new Date(ctx.lastSession.createdAt).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  if (daysSince > 7) {
    return [
      {
        id: "activity-resume",
        text: `Resume work on ${ctx.project.name} (${daysSince} days since last session)`,
        done: false,
        skipped: false,
        source: "activity",
      },
    ];
  }
  return [];
}

function actionsFromIssues(ctx: ActionContext): NextAction[] {
  if (!ctx.issues || ctx.issues.length === 0) return [];
  return ctx.issues.slice(0, 3).map((issue) => ({
    id: `issue-${issue.number}`,
    text: `Fix #${issue.number}: ${issue.title}`,
    done: false,
    skipped: false,
    source: "issue",
  }));
}

function actionsFromStack(ctx: ActionContext): NextAction[] {
  const { project } = ctx;
  if (!project.stack) return [];

  const actions: NextAction[] = [];
  const stackLower = project.stack.toLowerCase();

  const hasTestFramework =
    stackLower.includes("jest") ||
    stackLower.includes("vitest") ||
    stackLower.includes("mocha") ||
    stackLower.includes("playwright") ||
    stackLower.includes("cypress");

  if (!hasTestFramework) {
    actions.push({
      id: "stack-tests",
      text: "Add a test framework and write your first test",
      done: false,
      skipped: false,
      source: "stack",
    });
  }

  return actions;
}

function actionsFromPhase(ctx: ActionContext): NextAction[] {
  const actions: NextAction[] = [];
  const { phase, selectedFeatures } = ctx.project;
  const backlog = selectedFeatures || [];
  const nextFeature = backlog[0];

  switch (phase) {
    case "idea":
      actions.push({
        id: "idea-1",
        text: "Write a 1-sentence project pitch",
        done: false,
        skipped: false,
        source: "phase",
      });
      actions.push({
        id: "idea-2",
        text: "List 3 core features for your MVP",
        done: false,
        skipped: false,
        source: "phase",
      });
      break;

    case "mvp":
      if (nextFeature) {
        actions.push({
          id: "mvp-1",
          text: `Build ${nextFeature}`,
          done: false,
          skipped: false,
          source: "phase",
        });
      } else {
        actions.push({
          id: "mvp-3",
          text: "Build the next feature on your backlog",
          done: false,
          skipped: false,
          source: "phase",
        });
      }
      break;

    case "polish":
      actions.push({
        id: "polish-1",
        text: "Fix the top reported bug",
        done: false,
        skipped: false,
        source: "phase",
      });
      actions.push({
        id: "polish-2",
        text: "Improve error handling for edge cases",
        done: false,
        skipped: false,
        source: "phase",
      });
      break;

    case "deploy":
      actions.push({
        id: "deploy-1",
        text: "Set environment variables in production",
        done: false,
        skipped: false,
        source: "phase",
      });
      actions.push({
        id: "deploy-2",
        text: "Test the production build locally",
        done: false,
        skipped: false,
        source: "phase",
      });
      break;
  }

  return actions;
}

// --- Main function ---

export function generateNextActions(context: ActionContext): NextAction[] {
  const all: NextAction[] = [
    ...actionsFromSession(context),
    ...actionsFromActivity(context),
    ...actionsFromIssues(context),
    ...actionsFromStack(context),
    ...actionsFromPhase(context),
  ];

  // Deduplicate by id, limit to 3
  const seen = new Set<string>();
  const unique: NextAction[] = [];
  for (const action of all) {
    if (!seen.has(action.id)) {
      seen.add(action.id);
      unique.push(action);
    }
  }

  return unique.slice(0, 3);
}

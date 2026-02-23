import type { Project, Session, GitHubIssue } from "./types";

export interface NextAction {
  id: string;
  text: string;
  done: boolean;
  skipped: boolean;
  source?: "session" | "activity" | "issue";
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

// --- Main function ---

export function generateNextActions(context: ActionContext): NextAction[] {
  const all: NextAction[] = [
    ...actionsFromSession(context),
    ...actionsFromActivity(context),
    ...actionsFromIssues(context),
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

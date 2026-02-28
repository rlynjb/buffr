import type { Project, Session, WorkItem } from "./types";

export interface NextAction {
  id: string;
  text: string;
  done: boolean;
  skipped: boolean;
  source?: "session" | "activity" | "issue" | "ai";
}

export interface ActionContext {
  project: Project;
  lastSession: Session | null;
  workItems?: WorkItem[];
}

// --- Action source functions (priority order) ---

function actionsFromAI(ctx: ActionContext): NextAction[] {
  if (!ctx.lastSession?.suggestedNextStep) return [];
  return [
    {
      id: `ai-${ctx.lastSession.id}`,
      text: ctx.lastSession.suggestedNextStep,
      done: false,
      skipped: false,
      source: "ai",
    },
  ];
}

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

function actionsFromWorkItems(ctx: ActionContext): NextAction[] {
  if (!ctx.workItems || ctx.workItems.length === 0) return [];
  return ctx.workItems.slice(0, 3).map((item) => ({
    id: `issue-${item.id}`,
    text: `Fix #${item.id}: ${item.title}`,
    done: false,
    skipped: false,
    source: "issue",
  }));
}

// --- Main function ---

export function generateNextActions(context: ActionContext): NextAction[] {
  const all: NextAction[] = [
    ...actionsFromAI(context),
    ...actionsFromSession(context),
    ...actionsFromActivity(context),
    ...actionsFromWorkItems(context),
  ];

  // Deduplicate by id AND by text content, limit to 3
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();
  const unique: NextAction[] = [];
  for (const action of all) {
    const normalizedText = action.text.trim().toLowerCase();
    if (!seenIds.has(action.id) && !seenTexts.has(normalizedText)) {
      seenIds.add(action.id);
      seenTexts.add(normalizedText);
      unique.push(action);
    }
  }

  return unique.slice(0, 3);
}

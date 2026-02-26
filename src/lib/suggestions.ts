import type { Project, Session } from "./types";

export interface ProjectSuggestion {
  id: string;
  text: string;
  actionLabel: string;
  actionRoute?: string;
}

export function generateSuggestions(
  project: Project,
  lastSession: Session | null,
  connectedIntegrations: string[],
): ProjectSuggestion[] {
  const dismissed = project.dismissedSuggestions || [];
  const suggestions: ProjectSuggestion[] = [];

  // Rule 1: No data sources configured
  const dataSources = project.dataSources || [];
  if (dataSources.length === 0 && connectedIntegrations.length > 0) {
    suggestions.push({
      id: "connect-source",
      text: `Enable a data source (${connectedIntegrations.join(", ")}) to pull in issues and tasks.`,
      actionLabel: "Go to Tools",
      actionRoute: "/tools",
    });
  }

  // Rule 2: No sessions yet
  if (!lastSession && !project.lastSessionId) {
    suggestions.push({
      id: "first-session",
      text: "Start your first session to begin tracking your work on this project.",
      actionLabel: "Start working",
    });
  }

  // Rule 3: Idle > 14 days
  if (lastSession) {
    const daysSince = Math.floor(
      (Date.now() - new Date(lastSession.createdAt).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysSince > 14) {
      suggestions.push({
        id: "idle-project",
        text: `It's been ${daysSince} days since your last session. Time to pick this back up?`,
        actionLabel: "Resume",
      });
    }
  }

  // Rule 4: No prompts
  if (!dismissed.includes("add-prompts")) {
    suggestions.push({
      id: "add-prompts",
      text: "Add prompts to your library to speed up your AI workflow.",
      actionLabel: "Prompt Library",
      actionRoute: "/prompts",
    });
  }

  // Filter dismissed, limit to 2
  return suggestions
    .filter((s) => !dismissed.includes(s.id))
    .slice(0, 2);
}

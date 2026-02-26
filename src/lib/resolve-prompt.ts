import type { Project, Session, WorkItem } from "./types";

interface PromptContext {
  project?: Project | null;
  lastSession?: Session | null;
  issues?: WorkItem[];
}

/**
 * Replaces {{variable}} tokens in a prompt template with project context values.
 * Unknown variables are replaced with empty strings.
 */
export function resolvePrompt(template: string, ctx: PromptContext): string {
  const vars: Record<string, string> = {};

  if (ctx.project) {
    vars["project.name"] = ctx.project.name;
    vars["project.stack"] = ctx.project.stack;
    vars["project.description"] = ctx.project.description;
    vars["project.phase"] = ctx.project.phase;
    vars["project.goals"] = ctx.project.goals;
    vars["project.constraints"] = ctx.project.constraints;
  }

  if (ctx.lastSession) {
    vars["lastSession.goal"] = ctx.lastSession.goal;
    vars["lastSession.nextStep"] = ctx.lastSession.nextStep;
    vars["lastSession.blockers"] = ctx.lastSession.blockers || "";
  }

  if (ctx.issues && ctx.issues.length > 0) {
    vars["issues"] = ctx.issues
      .slice(0, 5)
      .map((i) => `#${i.id}: ${i.title}`)
      .join("\n");
  }

  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key: string) => {
    return vars[key] ?? "";
  });
}

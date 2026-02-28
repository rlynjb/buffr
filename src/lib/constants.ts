export const PHASE_COLORS: Record<string, string> = {
  idea: "#fbbf24",
  mvp: "#818cf8",
  polish: "#34d399",
  deploy: "#f472b6",
};

export const SOURCE_COLORS: Record<string, string> = {
  github: "#8b949e",
  jira: "#2684FF",
  notion: "#ffffffcc",
  ai: "#c084fc",
  session: "#a78bfa",
};

// Legacy mapping — kept for any remaining consumers during migration
export const PHASE_BADGE_VARIANTS: Record<string, "default" | "accent" | "warning" | "success"> = {
  idea: "default",
  mvp: "accent",
  polish: "warning",
  deploy: "success",
};

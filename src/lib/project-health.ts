import type { Session } from "./types";

export interface ProjectHealth {
  projectId: string;
  needsAttention: boolean; // true if no activity this week
}

/** Returns Sunday 00:00:00 of the week containing `date` */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // getDay() 0=Sun
  return d;
}

export function computeProjectHealth(
  projectId: string,
  sessions: Session[],
  lastSyncedAt?: string | null
): ProjectHealth {
  const now = new Date();
  const weekStart = getWeekStart(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const activityDates = sessions.map((s) => new Date(s.createdAt));
  if (lastSyncedAt) {
    activityDates.push(new Date(lastSyncedAt));
  }

  const hasActivityThisWeek = activityDates.some(
    (d) => d >= weekStart && d < weekEnd
  );

  return {
    projectId,
    needsAttention: !hasActivityThisWeek,
  };
}

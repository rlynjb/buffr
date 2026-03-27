import type { Session } from "./types";

export interface DayActivity {
  day: number; // 0=Sun, 1=Mon, ..., 6=Sat
  active: boolean;
}

export interface ProjectHealth {
  projectId: string;
  weekDays: DayActivity[]; // 7 entries, Sun-Sat
  needsAttention: boolean; // true if zero active days this week
  weeklyStreak: number; // consecutive weeks with >=1 session
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

  // Collect all activity dates (session dates + lastSyncedAt)
  const activityDates = sessions.map((s) => new Date(s.createdAt));
  if (lastSyncedAt) {
    activityDates.push(new Date(lastSyncedAt));
  }

  // Build weekDays for current week
  const weekDays: DayActivity[] = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(weekStart);
    dayStart.setDate(dayStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const active = activityDates.some((d) => d >= dayStart && d < dayEnd);
    return { day: i, active };
  });

  const hasActivityThisWeek = weekDays.some((d) => d.active);

  // Weekly streak: walk backwards through weeks
  let streak = 0;
  if (activityDates.length > 0) {
    let checkWeek = new Date(weekStart);
    // Start from current week
    while (true) {
      const wEnd = new Date(checkWeek);
      wEnd.setDate(wEnd.getDate() + 7);
      const hasActivity = activityDates.some(
        (d) => d >= checkWeek && d < wEnd
      );
      if (hasActivity) {
        streak++;
        checkWeek.setDate(checkWeek.getDate() - 7);
      } else {
        break;
      }
    }
  }

  return {
    projectId,
    weekDays,
    needsAttention: !hasActivityThisWeek,
    weeklyStreak: streak,
  };
}

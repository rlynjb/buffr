import { db } from "../../db/client";
import { projects } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { Project } from "../../../../../src/lib/types";

export async function upsertProject(project: Project): Promise<void> {
  await db.insert(projects).values({
    id: project.id,
    name: project.name,
    description: project.description,
    stack: project.stack,
    phase: project.phase,
    githubRepo: project.githubRepo,
    netlifySiteUrl: project.netlifySiteUrl,
    dataSources: project.dataSources || [],
    dismissedSuggestions: project.dismissedSuggestions || [],
    lastSessionId: project.lastSessionId,
    lastSyncedAt: project.lastSyncedAt ? new Date(project.lastSyncedAt) : null,
    updatedAt: new Date(project.updatedAt),
  }).onConflictDoUpdate({
    target: projects.id,
    set: {
      name: project.name,
      description: project.description,
      stack: project.stack,
      phase: project.phase,
      githubRepo: project.githubRepo,
      netlifySiteUrl: project.netlifySiteUrl,
      dataSources: project.dataSources || [],
      dismissedSuggestions: project.dismissedSuggestions || [],
      lastSessionId: project.lastSessionId,
      lastSyncedAt: project.lastSyncedAt ? new Date(project.lastSyncedAt) : null,
      updatedAt: new Date(project.updatedAt),
    },
  });
}

export async function deleteProjectDb(id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

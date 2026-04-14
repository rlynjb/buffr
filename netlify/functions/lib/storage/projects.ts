import type { Project } from "../../../../src/lib/types";
import { db } from "../db/client";
import { projects } from "../db/schema";
import { eq, desc } from "drizzle-orm";

function rowToProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stack: row.stack,
    phase: row.phase as Project["phase"],
    lastSessionId: row.lastSessionId,
    githubRepo: row.githubRepo,
    netlifySiteUrl: row.netlifySiteUrl,
    dataSources: row.dataSources,
    dismissedSuggestions: row.dismissedSuggestions,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getProject(id: string): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToProject(rows[0]);
}

export async function listProjects(): Promise<Project[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  return rows.map(rowToProject);
}

export async function saveProject(project: Project): Promise<Project> {
  project.updatedAt = new Date().toISOString();
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
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

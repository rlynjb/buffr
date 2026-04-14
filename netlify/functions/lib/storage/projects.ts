import { getStore } from "@netlify/blobs";
import type { Project } from "../../../../src/lib/types";
import { db } from "../db/client";
import { projects } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { dbWrite } from "./db/write-guard";
import { upsertProject, deleteProjectDb } from "./db/projects";

const STORE_NAME = "projects";

function store() {
  return getStore(STORE_NAME);
}

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
  const s = store();
  project.updatedAt = new Date().toISOString();
  await s.set(project.id, JSON.stringify(project));
  await dbWrite("saveProject", () => upsertProject(project));
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
  await dbWrite("deleteProject", () => deleteProjectDb(id));
}

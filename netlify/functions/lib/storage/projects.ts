import { getStore } from "@netlify/blobs";
import type { Project } from "../../../../src/lib/types";

const STORE_NAME = "projects";

function store() {
  return getStore(STORE_NAME);
}

export async function getProject(id: string): Promise<Project | null> {
  const s = store();
  const data = await s.get(id, { type: "text" });
  if (!data) return null;
  return JSON.parse(data) as Project;
}

export async function listProjects(): Promise<Project[]> {
  const s = store();
  const { blobs } = await s.list();
  const projects: Project[] = [];
  for (const blob of blobs) {
    const data = await s.get(blob.key, { type: "text" });
    if (data) {
      projects.push(JSON.parse(data) as Project);
    }
  }
  return projects.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function saveProject(project: Project): Promise<Project> {
  const s = store();
  project.updatedAt = new Date().toISOString();
  await s.set(project.id, JSON.stringify(project));
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  const s = store();
  await s.delete(id);
}

import type { AgentTool } from "./types";
import type { BuffrSpecCategory, BuffrSpecItem } from "../../../../../src/lib/types";
import { saveBuffrSpecItem, listBuffrSpecItems } from "../../storage/buffr-specs";
import { randomUUID } from "crypto";

interface SaveSpecInput {
  projectId: string;
  category: BuffrSpecCategory;
  title: string;
  content: string;
}

interface SaveSpecOutput {
  id: string;
  path: string;
}

export const saveSpec: AgentTool = {
  name: "saveSpec",
  description: "Creates a BuffrSpecItem row. Generates unique filename on conflict. Returns { id, path }.",
  async execute(input: unknown): Promise<SaveSpecOutput> {
    const { projectId, category, title, content } = input as SaveSpecInput;

    let baseFilename = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    if (!baseFilename) baseFilename = "spec";
    baseFilename += ".md";

    // Check for conflicts and generate unique filename
    const existing = await listBuffrSpecItems();
    const projectSpecs = existing.filter((s) => s.scope === projectId);
    const existingPaths = new Set(projectSpecs.map((s) => s.path));

    let filename = baseFilename;
    let path = `.buffr/specs/${category}/${filename}`;
    let attempt = 1;
    while (existingPaths.has(path)) {
      filename = baseFilename.replace(/\.md$/, `-${attempt}.md`);
      path = `.buffr/specs/${category}/${filename}`;
      attempt++;
    }

    const now = new Date().toISOString();
    const item: BuffrSpecItem = {
      id: randomUUID(),
      category,
      filename,
      path,
      title,
      content,
      scope: projectId,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    await saveBuffrSpecItem(item);
    return { id: item.id, path: item.path };
  },
};

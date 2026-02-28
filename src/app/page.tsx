"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/dashboard/project-card";
import { ImportProjectModal } from "@/components/dashboard/import-project-modal";
import { IconFolder, IconPrompt, IconTool } from "@/components/icons";
import type { Project } from "@/lib/types";
import { listProjects, listPrompts, listIntegrations } from "@/lib/api";

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [promptCount, setPromptCount] = useState(0);
  const [toolCount, setToolCount] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const data = await listProjects();
        setProjects(data);
      } catch (err) {
        console.error("Failed to load projects:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
    listPrompts().then((p) => setPromptCount(p.length)).catch(() => {});
    listIntegrations().then((i) => setToolCount(i.reduce((n, x) => n + x.tools.length, 0))).catch(() => {});

    // Listen for command palette "Load Existing" action
    function onOpenImport() { setImportOpen(true); }
    window.addEventListener("buffr:open-import", onOpenImport);
    return () => window.removeEventListener("buffr:open-import", onOpenImport);
  }, []);

  function handleCreated(project: Project) {
    setImportOpen(false);
    router.push(`/project/${project.id}`);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
        <Button size="sm" onClick={() => setImportOpen(true)}>
          <IconFolder size={14} /> Load Existing
        </Button>
      </div>

      {/* Quick nav */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => router.push("/prompts")}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800/50 bg-zinc-900/20 hover:bg-zinc-800/30 hover:border-zinc-700/50 text-sm text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer"
        >
          <IconPrompt size={14} />
          <span>Prompt Library</span>
          <span className="text-[10px] text-zinc-600">{promptCount}</span>
        </button>
        <button
          onClick={() => router.push("/tools")}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800/50 bg-zinc-900/20 hover:bg-zinc-800/30 hover:border-zinc-700/50 text-sm text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer"
        >
          <IconTool size={14} />
          <span>Tools</span>
          <span className="text-[10px] text-zinc-600">{toolCount}</span>
        </button>
      </div>

      {/* Project List */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 rounded-xl border border-zinc-800/60 bg-zinc-900/30 animate-pulse"
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-500 text-sm mb-4">
            No projects yet. Import a GitHub repository to get started.
          </p>
          <Button onClick={() => setImportOpen(true)}>
            <IconFolder size={14} /> Import a project
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => router.push(`/project/${project.id}`)}
            />
          ))}
        </div>
      )}

      <ImportProjectModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}

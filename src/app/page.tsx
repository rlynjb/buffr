"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/dashboard/project-card";
import { ImportProjectModal } from "@/components/dashboard/import-project-modal";
import type { Project } from "@/lib/types";
import { listProjects } from "@/lib/api";

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);

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
  }, []);

  function handleCreated(project: Project) {
    setImportOpen(false);
    router.push(`/project/${project.id}`);
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground font-mono">
            buffr
          </h1>
          <p className="text-sm text-muted mt-1">
            Your projects, sessions, and momentum — all in one place.
          </p>
        </div>
        <Button onClick={() => setImportOpen(true)}>Import a project</Button>
      </div>

      {/* Quick Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => setImportOpen(true)}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          + Import a project
        </button>
        <button
          onClick={() => router.push("/prompts")}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          Prompts
        </button>
        <button
          onClick={() => router.push("/tools")}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          Tools
        </button>
      </div>

      {/* Project List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-xl border border-border bg-card animate-pulse"
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted text-sm mb-4">
            No projects yet. Import a GitHub repository to get started.
          </p>
          <Button onClick={() => setImportOpen(true)}>
            Import a project
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
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

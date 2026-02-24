"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/dashboard/project-card";
import type { Project } from "@/lib/types";
import { listProjects, deleteProject, getUserRepos } from "@/lib/api";

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [data, githubRepos] = await Promise.all([
          listProjects(),
          getUserRepos().catch(() => [] as string[]),
        ]);

        const repoSet = new Set(githubRepos.map((r) => r.toLowerCase()));

        // Keep projects whose githubRepo still exists on GitHub
        const active = data.filter(
          (p) => p.githubRepo && repoSet.has(p.githubRepo.toLowerCase())
        );
        const stale = data.filter(
          (p) => !p.githubRepo || !repoSet.has(p.githubRepo.toLowerCase())
        );

        setProjects(active);

        // Clean up stale projects in background
        for (const p of stale) {
          deleteProject(p.id).catch((err) =>
            console.warn(`Failed to delete stale project ${p.id}:`, err)
          );
        }
      } catch (err) {
        console.error("Failed to load projects:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => router.push("/load")}>
            Load Existing
          </Button>
          <Button onClick={() => router.push("/new")}>New Project</Button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => router.push("/new")}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          + New Project
        </button>
        <button
          onClick={() => router.push("/load")}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          + Load Existing
        </button>
        <button
          onClick={() => router.push("/prompts")}
          className="flex-1 rounded-lg border border-dashed border-border p-4 text-sm text-muted hover:border-accent hover:text-accent transition-colors text-center cursor-pointer"
        >
          Prompts
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
            No projects yet. Create your first project to get started.
          </p>
          <Button onClick={() => router.push("/new")}>
            Create First Project
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
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "@/components/dashboard/project-card";
import { ImportProjectModal } from "@/components/dashboard/import-project-modal";
import { Modal } from "@/components/ui/modal";
import { IconFolder, IconPrompt, IconTool } from "@/components/icons";
import type { Project } from "@/lib/types";
import { listProjects, listPrompts, listIntegrations, deleteProject } from "@/lib/api";
import "./page.css";

export default function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
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

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteProject(deleteTarget.id);
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    } catch (err) {
      console.error("Failed to delete project:", err);
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div>
      <div className="dashboard__header">
        <h1 className="dashboard__title">Projects</h1>
        <Button size="sm" onClick={() => setImportOpen(true)}>
          <IconFolder size={14} /> Load Existing
        </Button>
      </div>

      <div className="dashboard__quick-nav">
        <button
          onClick={() => router.push("/prompts")}
          className="dashboard__quick-nav-btn"
        >
          <IconPrompt size={14} />
          <span>Prompt Library</span>
          <span className="dashboard__quick-nav-count">{promptCount}</span>
        </button>
        <button
          onClick={() => router.push("/tools")}
          className="dashboard__quick-nav-btn"
        >
          <IconTool size={14} />
          <span>Tools</span>
          <span className="dashboard__quick-nav-count">{toolCount}</span>
        </button>
      </div>

      {loading ? (
        <div className="dashboard__list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="dashboard__skeleton" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="dashboard__empty">
          <p className="dashboard__empty-text">
            No projects yet. Import a GitHub repository to get started.
          </p>
          <Button onClick={() => setImportOpen(true)}>
            <IconFolder size={14} /> Import a project
          </Button>
        </div>
      ) : (
        <div className="dashboard__list">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => router.push(`/project/${project.id}`)}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      <ImportProjectModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={handleCreated}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete project"
        subtitle={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
      >
        <div className="dashboard__confirm-actions">
          <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

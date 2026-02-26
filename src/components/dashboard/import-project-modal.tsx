"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { executeToolAction, createProject } from "@/lib/api";
import type { Project } from "@/lib/types";

interface ImportProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export function ImportProjectModal({
  open,
  onClose,
  onCreated,
}: ImportProjectModalProps) {
  const [ownerRepo, setOwnerRepo] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    setError(null);
    const trimmed = ownerRepo.trim().replace(/\.git$/, "");
    const parts = trimmed.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setError("Enter a valid owner/repo (e.g. acme/my-app)");
      return;
    }
    const [owner, repo] = parts;

    setImporting(true);
    try {
      const res = await executeToolAction("github_analyze_repo", { owner, repo });
      if (!res.ok) {
        throw new Error(res.error || "Failed to analyze repository");
      }

      const analysis = res.result as {
        detectedStack?: string;
        detectedPhase?: "idea" | "mvp" | "polish" | "deploy";
        description?: string;
        frameworks?: string[];
      };

      const project = await createProject({
        name: repo,
        description: analysis.description || "",
        stack: analysis.detectedStack || "",
        phase: analysis.detectedPhase || "mvp",
        githubRepo: `${owner}/${repo}`,
        repoVisibility: "private",
        dataSources: ["github"],
        constraints: "",
        goals: "",
      });

      setOwnerRepo("");
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import project");
    } finally {
      setImporting(false);
    }
  }

  function handleClose() {
    if (importing) return;
    setOwnerRepo("");
    setError(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Import a project">
      <div className="space-y-4">
        <Input
          label="GitHub Repository"
          placeholder="owner/repo"
          value={ownerRepo}
          onChange={(e) => {
            setOwnerRepo(e.target.value);
            setError(null);
          }}
          error={error || undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !importing) handleImport();
          }}
        />
        <p className="text-xs text-muted">
          The repository will be analyzed to detect its stack and development phase.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="secondary" onClick={handleClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={importing || !ownerRepo.trim()}>
            {importing ? "Importing..." : "Import"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

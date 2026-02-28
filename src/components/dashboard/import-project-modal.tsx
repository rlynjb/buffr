"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconLoader, IconPlus } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import { executeToolAction, createProject } from "@/lib/api";
import type { Project } from "@/lib/types";
import "./import-project-modal.css";

interface ImportProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

interface AnalysisResult {
  name: string;
  detectedStack?: string;
  detectedPhase?: "idea" | "mvp" | "polish" | "deploy";
  description?: string;
  frameworks?: string[];
  devTools?: string[];
  openIssues?: number;
  lastCommit?: string;
}

export function ImportProjectModal({
  open,
  onClose,
  onCreated,
}: ImportProjectModalProps) {
  const [ownerRepo, setOwnerRepo] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  function parseInput(raw: string): { owner: string; repo: string } | null {
    const trimmed = raw.trim().replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
    const parts = trimmed.split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  }

  async function handleAnalyze() {
    setError(null);
    const parsed = parseInput(ownerRepo);
    if (!parsed) {
      setError("Enter owner/repo or a GitHub URL");
      return;
    }

    setAnalyzing(true);
    try {
      const res = await executeToolAction("github_analyze_repo", parsed);
      if (!res.ok) throw new Error(res.error || "Failed to analyze repository");
      const analysis = res.result as AnalysisResult;
      setResult({
        ...analysis,
        name: parsed.repo,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze");
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleImport() {
    if (!result) return;
    const parsed = parseInput(ownerRepo);
    if (!parsed) return;

    setImporting(true);
    try {
      const project = await createProject({
        name: result.name,
        description: result.description || "",
        stack: result.detectedStack || "",
        phase: result.detectedPhase || "mvp",
        githubRepo: `${parsed.owner}/${parsed.repo}`,
        repoVisibility: "private",
        dataSources: ["github"],
        constraints: "",
        goals: "",
      });
      handleClose();
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import project");
    } finally {
      setImporting(false);
    }
  }

  function handleClose() {
    if (analyzing || importing) return;
    setOwnerRepo("");
    setError(null);
    setResult(null);
    onClose();
  }

  const phase = result?.detectedPhase || "mvp";
  const stack = result?.frameworks || (result?.detectedStack ? result.detectedStack.split(",").map((s) => s.trim()) : []);
  const devTools = result?.devTools || [];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Load Existing Project"
      subtitle="Enter a GitHub repo URL. buffr will analyze it and set up tracking."
    >
      <div className="space-y-4">
        <div className="import-modal__form">
          <div className="import-modal__input">
            <Input
              value={ownerRepo}
              onChange={(e) => { setOwnerRepo(e.target.value); setError(null); setResult(null); }}
              placeholder="rein/recipe-hub or https://github.com/rein/recipe-hub"
              mono
              error={error || undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !analyzing) handleAnalyze();
              }}
            />
          </div>
          <Button onClick={handleAnalyze} disabled={!ownerRepo.trim() || analyzing}>
            {analyzing ? <><IconLoader size={14} /> Analyzing...</> : "Analyze"}
          </Button>
        </div>

        {result && (
          <div className="import-modal__result">
            <div className="import-modal__result-header">
              <span className="import-modal__result-name">
                {result.name}
              </span>
              <Badge color={PHASE_COLORS[phase]}>{phase}</Badge>
              {result.openIssues != null && (
                <span className="import-modal__result-issues">
                  {result.openIssues} open issues
                </span>
              )}
            </div>

            {stack.length > 0 && (
              <div className="import-modal__result-tags">
                {stack.map((s) => (
                  <Badge key={s} color="#818cf8">{s}</Badge>
                ))}
                {devTools.map((t) => (
                  <Badge key={t} small>{t}</Badge>
                ))}
              </div>
            )}

            <div className="import-modal__result-footer">
              <Button variant="secondary" onClick={handleClose}>Cancel</Button>
              <Button onClick={handleImport} disabled={importing}>
                <IconPlus size={14} /> {importing ? "Importing..." : "Import Project"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

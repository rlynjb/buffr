"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { createProject, analyzeRepo, validateRepo } from "@/lib/api";
import { AVAILABLE_PROJECT_FILES } from "@/lib/types";
import type { GitHubIssue } from "@/lib/types";
import { PHASE_BADGE_VARIANTS } from "@/lib/constants";

interface LoadExistingProps {
  onLoaded: (projectId: string) => void;
}

interface RepoAnalysis {
  detectedStack: string;
  frameworks: string[];
  devTools: string[];
  hasTests: boolean;
  hasCI: boolean;
  hasDeployConfig: boolean;
  fileCount: number;
  detectedPhase: "idea" | "mvp" | "polish" | "deploy";
  issues: GitHubIssue[];
  issueCount: number;
}

export function LoadExisting({ onLoaded }: LoadExistingProps) {
  const [repoInput, setRepoInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<{
    name: string;
    description: string | null;
  } | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [showFileOptions, setShowFileOptions] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);

  function parseRepoInput(input: string): string {
    const match = input.match(
      /(?:github\.com\/)?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/
    );
    return match ? match[1].replace(/\.git$/, "") : input.trim().replace(/\.git$/, "");
  }

  async function handleValidate() {
    setLoading(true);
    setError(null);
    setRepoInfo(null);
    setAnalysis(null);

    try {
      const ownerRepo = parseRepoInput(repoInput);
      if (!ownerRepo.includes("/")) {
        throw new Error(
          "Please enter a valid repo in owner/repo format"
        );
      }

      const data = await validateRepo(ownerRepo);

      setRepoInfo({
        name: data.name || ownerRepo.split("/")[1],
        description: data.description ?? null,
      });
      setShowFileOptions(true);

      // Kick off analysis in background
      setAnalyzing(true);
      analyzeRepo(ownerRepo)
        .then((result) => setAnalysis(result))
        .catch((err) => console.warn("Analysis failed:", err))
        .finally(() => setAnalyzing(false));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to validate repository"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleLoad() {
    setLoading(true);
    setError(null);

    try {
      const ownerRepo = parseRepoInput(repoInput);
      const project = await createProject({
        name: repoInfo?.name || ownerRepo.split("/")[1],
        description: repoInfo?.description || "",
        githubRepo: ownerRepo,
        repoVisibility: "public",
        phase: analysis?.detectedPhase || "mvp",
        stack: analysis?.detectedStack || "",
        issueCount: analysis?.issueCount,
        selectedFiles: selectedFiles.length > 0 ? selectedFiles : null,
      });
      onLoaded(project.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load project"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">
          Load Existing Project
        </h1>
        <p className="text-sm text-muted">
          Connect an existing GitHub repository to buffr.
        </p>
      </div>

      <Input
        label="GitHub Repository"
        value={repoInput}
        onChange={(e) => setRepoInput(e.target.value)}
        placeholder="owner/repo or https://github.com/owner/repo"
      />

      {error && (
        <div className="rounded-lg border border-error/20 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {!showFileOptions && (
        <Button
          onClick={handleValidate}
          loading={loading}
          disabled={!repoInput.trim()}
        >
          Validate &amp; Continue
        </Button>
      )}

      {showFileOptions && (
        <>
          {repoInfo && (
            <Card>
              <p className="text-sm">
                <span className="text-muted">Repository: </span>
                <span className="font-mono text-foreground">
                  {parseRepoInput(repoInput)}
                </span>
              </p>
              {repoInfo.description && (
                <p className="text-xs text-muted mt-1">
                  {repoInfo.description}
                </p>
              )}
            </Card>
          )}

          {/* Analysis results */}
          {analyzing && (
            <Card>
              <div className="flex items-center gap-2 text-sm text-muted">
                <span className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                Analyzing repository...
              </div>
            </Card>
          )}

          {analysis && (
            <Card>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Analysis
              </h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted">Stack: </span>
                  <span className="font-mono text-foreground">
                    {analysis.detectedStack}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted">Phase: </span>
                  <Badge variant={PHASE_BADGE_VARIANTS[analysis.detectedPhase]}>
                    {analysis.detectedPhase}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted">
                  <span>{analysis.fileCount} files</span>
                  {analysis.hasTests && (
                    <span className="text-success">has tests</span>
                  )}
                  {analysis.hasCI && (
                    <span className="text-success">has CI</span>
                  )}
                  {analysis.hasDeployConfig && (
                    <span className="text-success">has deploy config</span>
                  )}
                </div>
                {analysis.devTools.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {analysis.devTools.map((tool) => (
                      <Badge key={tool} variant="default">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                )}
                {analysis.issueCount > 0 && (
                  <div className="text-muted">
                    {analysis.issueCount} open issue
                    {analysis.issueCount !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Add project files? (optional)
            </h3>
            <p className="text-xs text-muted mb-3">
              Select files to generate and push to the repository.
            </p>
            <div className="space-y-0.5">
              {AVAILABLE_PROJECT_FILES.map((file) => (
                <Checkbox
                  key={file}
                  checked={selectedFiles.includes(file)}
                  onChange={(checked) =>
                    setSelectedFiles((prev) =>
                      checked
                        ? [...prev, file]
                        : prev.filter((f) => f !== file)
                    )
                  }
                  label={file}
                />
              ))}
            </div>
          </Card>

          <Button onClick={handleLoad} loading={loading}>
            Load Project
          </Button>
        </>
      )}
    </div>
  );
}

"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProgressStep, type StepStatus } from "@/components/ui/progress-step";
import type { FlowState } from "@/lib/flow-state";
import { useProvider } from "@/context/provider-context";
import { scaffoldProject, deployProject, createProject } from "@/lib/api";

interface DeployStep {
  name: string;
  status: StepStatus;
  result?: string;
  error?: string;
}

interface StepDeployProps {
  state: FlowState;
  onComplete: (projectId: string) => void;
  onBack: () => void;
  onChange: (field: string, value: string) => void;
}

export function StepDeploy({ state, onComplete, onBack, onChange }: StepDeployProps) {
  const { selected: provider } = useProvider();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [results, setResults] = useState<{
    repoUrl?: string;
    siteUrl?: string;
    files?: string[];
    githubRepo?: string;
    siteId?: string;
  }>({});

  const [steps, setSteps] = useState<DeployStep[]>([
    { name: "Generate project scaffold and files", status: "pending" },
    { name: "Create GitHub repository", status: "pending" },
    { name: "Push initial commit", status: "pending" },
    { name: "Create Netlify site", status: "pending" },
    { name: "Save project record", status: "pending" },
  ]);

  const updateStep = useCallback(
    (index: number, updates: Partial<DeployStep>) => {
      setSteps((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    []
  );

  async function execute() {
    setRunning(true);
    setErrorMessage(null);

    try {
      // Steps 1-3: Scaffold (generates files, creates repo, pushes)
      updateStep(0, { status: "running" });
      updateStep(1, { status: "running" });
      updateStep(2, { status: "running" });

      const scaffoldResult = await scaffoldProject({
        projectName: state.plan!.projectName,
        description: state.description,
        stack: state.plan!.recommendedStack,
        features: state.plan!.features,
        selectedFiles: state.selectedFiles,
        repoName: state.repoName,
        repoVisibility: state.repoVisibility,
        repoDescription: state.repoDescription,
        provider,
        constraints: state.constraints,
        goals: state.goals,
      });

      updateStep(0, {
        status: "success",
        result: `${scaffoldResult.files.length} files generated`,
      });
      updateStep(1, {
        status: "success",
        result: scaffoldResult.githubRepo,
      });
      updateStep(2, {
        status: "success",
        result: scaffoldResult.repoUrl,
      });

      setResults((r) => ({
        ...r,
        repoUrl: scaffoldResult.repoUrl,
        files: scaffoldResult.files,
        githubRepo: scaffoldResult.githubRepo,
      }));

      // Step 4: Create Netlify site
      updateStep(3, { status: "running" });

      const deployResult = await deployProject({
        githubRepo: scaffoldResult.githubRepo,
        projectName: state.plan!.projectName,
      });

      updateStep(3, {
        status: "success",
        result: deployResult.siteUrl,
      });

      setResults((r) => ({
        ...r,
        siteUrl: deployResult.siteUrl,
        siteId: deployResult.siteId,
      }));

      // Step 5: Save project
      updateStep(4, { status: "running" });

      const project = await createProject({
        name: state.plan!.projectName,
        description: state.plan!.description || state.description,
        constraints: state.constraints,
        goals: state.goals,
        stack: state.plan!.recommendedStack,
        phase: "mvp",
        githubRepo: scaffoldResult.githubRepo,
        repoVisibility: state.repoVisibility,
        netlifySiteId: deployResult.siteId,
        netlifySiteUrl: deployResult.siteUrl,
        plan: state.plan,
        selectedFeatures: state.plan!.features
          .filter((f) => f.checked)
          .map((f) => f.name),
        selectedFiles: state.selectedFiles,
      });

      updateStep(4, { status: "success", result: `ID: ${project.id}` });
      setProjectId(project.id);
      setDone(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      setErrorMessage(message);
      // Mark the current running step as failed
      setSteps((prev) =>
        prev.map((s) =>
          s.status === "running" ? { ...s, status: "failed", error: message } : s
        )
      );
    } finally {
      setRunning(false);
    }
  }

  const checkedFeatures = state.plan!.features.filter(
    (f) => f.checked && f.phase === 1
  );

  if (done && projectId) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="text-center py-8">
          <div className="text-4xl mb-4">&#10003;</div>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            Project Created!
          </h1>
          <p className="text-muted text-sm">
            Your project is set up. Link the GitHub repo in your Netlify dashboard to enable builds.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {results.repoUrl && (
            <a
              href={results.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-border bg-card p-4 hover:bg-card-hover transition-colors"
            >
              <span className="text-sm font-medium text-foreground">
                GitHub Repository
              </span>
              <span className="block text-xs text-accent font-mono mt-1">
                {results.repoUrl}
              </span>
            </a>
          )}
          {results.siteUrl && (
            <a
              href={results.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-border bg-card p-4 hover:bg-card-hover transition-colors"
            >
              <span className="text-sm font-medium text-foreground">
                Netlify Site
              </span>
              <span className="block text-xs text-accent font-mono mt-1">
                {results.siteUrl}
              </span>
            </a>
          )}
        </div>

        {results.files && results.files.length > 0 && (
          <Card>
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Files Created
            </h3>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {results.files.map((f) => (
                <p key={f} className="text-xs text-muted font-mono">
                  {f}
                </p>
              ))}
            </div>
          </Card>
        )}

        <Button onClick={() => onComplete(projectId)} size="lg">
          Go to Project
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">
          Create &amp; Deploy
        </h1>
        <p className="text-sm text-muted">
          Review the summary below, then create everything with one click.
        </p>
      </div>

      {/* Summary */}
      <Card>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Project</span>
            <span className="font-mono text-foreground">
              {state.plan!.projectName}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Stack</span>
            <span className="font-mono text-foreground text-right max-w-[60%]">
              {state.plan!.recommendedStack}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Repository</span>
            <span className="font-mono text-foreground">
              {state.repoName}{" "}
              <Badge>{state.repoVisibility}</Badge>
            </span>
          </div>
          <div>
            <span className="text-muted block mb-1">
              Phase 1 Features ({checkedFeatures.length})
            </span>
            <div className="flex flex-wrap gap-1">
              {checkedFeatures.map((f, i) => (
                <Badge key={i} variant="accent">
                  {f.name}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <span className="text-muted block mb-1">
              Project Files ({state.selectedFiles.length})
            </span>
            <div className="flex flex-wrap gap-1">
              {state.selectedFiles.map((f) => (
                <Badge key={f}>{f}</Badge>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Progress */}
      {running || steps.some((s) => s.status !== "pending") ? (
        <Card>
          <div className="space-y-0">
            {steps.map((s, i) => (
              <ProgressStep key={i} {...s} />
            ))}
          </div>
        </Card>
      ) : null}

      {/* Error with editable fields */}
      {errorMessage && !running && (
        <Card>
          <p className="text-sm text-error mb-4">{errorMessage}</p>
          <div className="space-y-3">
            <Input
              label="Project Name"
              value={state.plan!.projectName}
              onChange={(e) => onChange("projectName", e.target.value)}
            />
            <Input
              label="Repository Name"
              value={state.repoName}
              onChange={(e) => onChange("repoName", e.target.value)}
            />
          </div>
        </Card>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack} disabled={running}>
          Back
        </Button>
        {!errorMessage ? (
          <Button
            onClick={execute}
            loading={running}
            disabled={running}
            size="lg"
          >
            Create and Deploy
          </Button>
        ) : (
          <Button
            onClick={() => {
              setSteps((prev) =>
                prev.map((s) => ({ ...s, status: "pending" as const, error: undefined }))
              );
              execute();
            }}
            disabled={running}
            size="lg"
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

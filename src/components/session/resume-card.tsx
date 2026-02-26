"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Project, Session, WorkItem, Prompt } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listSessions, getActionNotes, saveActionNote, listPrompts, executeToolAction, listIntegrations, updateProject } from "@/lib/api";
import { resolvePrompt } from "@/lib/resolve-prompt";
import { getToolForCapability } from "@/lib/data-sources";
import { PHASE_BADGE_VARIANTS } from "@/lib/constants";
import { generateSuggestions, type ProjectSuggestion } from "@/lib/suggestions";
import { SessionTab } from "./session-tab";
import { IssuesTab } from "./issues-tab";
import { ActionsTab } from "./actions-tab";
import { PromptsTab } from "./prompts-tab";
import { DataSourceCheckboxes } from "./data-source-checkboxes";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
}

type Tab = "session" | "issues" | "actions" | "prompts";

export function ResumeCard({ project, onEndSession }: ResumeCardProps) {
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [dataSources, setDataSources] = useState<string[]>(project.dataSources || (project.githubRepo ? ["github"] : []));
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [currentProject, setCurrentProject] = useState(project);

  async function handleSync() {
    if (!currentProject.githubRepo || syncing) return;
    const [owner, repo] = currentProject.githubRepo.split("/");
    setSyncing(true);
    try {
      const res = await executeToolAction("github_analyze_repo", { owner, repo });
      if (res.ok && res.result) {
        const analysis = res.result as {
          detectedStack?: string;
          detectedPhase?: "idea" | "mvp" | "polish" | "deploy";
          description?: string;
        };
        const updates: Partial<Project> = {};
        if (analysis.detectedStack) updates.stack = analysis.detectedStack;
        if (analysis.detectedPhase) updates.phase = analysis.detectedPhase;
        if (analysis.description) updates.description = analysis.description;
        const updated = await updateProject(currentProject.id, updates);
        setCurrentProject(updated);
      }
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    async function fetchWorkItems(): Promise<WorkItem[]> {
      const sources = dataSources;
      const results = await Promise.all(
        sources.map(async (source) => {
          const toolName = getToolForCapability(source, "list_open_items");
          if (!toolName) return [] as WorkItem[];
          try {
            const params: Record<string, unknown> = {};
            if (source === "github" && project.githubRepo) {
              const [owner, repo] = project.githubRepo.split("/");
              params.owner = owner;
              params.repo = repo;
            }
            const res = await executeToolAction(toolName, params);
            if (res.ok && res.result) {
              const data = res.result as { items?: WorkItem[] };
              return data.items || [];
            }
            return [] as WorkItem[];
          } catch {
            return [] as WorkItem[];
          }
        })
      );
      return results.flat();
    }

    async function load() {
      try {
        const [sessions, items, savedNotes, fetchedPrompts] = await Promise.all([
          listSessions(project.id),
          fetchWorkItems(),
          getActionNotes(project.id).catch(() => ({} as Record<string, string>)),
          listPrompts(project.id).catch(() => [] as Prompt[]),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setWorkItems(items);
        setNotes(savedNotes);
        setPrompts(fetchedPrompts);

        const ctx: ActionContext = {
          project,
          lastSession: last,
          workItems: items,
        };
        setActions(generateNextActions(ctx));

        // Generate suggestions
        listIntegrations()
          .then((integrations) => {
            const connected = integrations
              .filter((i) => i.status === "connected")
              .map((i) => i.id);
            setSuggestions(generateSuggestions(project, last, connected));
          })
          .catch(() => setSuggestions([]));
      } catch {
        setActions(generateNextActions({ project, lastSession: null }));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [project, dataSources]);

  function handleActionDone(id: string) {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, done: true } : a))
    );
  }

  function handleActionSkip(id: string) {
    setActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, skipped: true } : a))
    );
  }

  async function handleCopyPrompt(prompt: Prompt) {
    const resolved = resolvePrompt(prompt.body, {
      project,
      lastSession,
      issues: workItems,
    });
    await navigator.clipboard.writeText(resolved);
    setCopiedPrompt(prompt.id);
    setTimeout(() => setCopiedPrompt(null), 1500);
  }

  async function handleNoteSave(actionId: string) {
    setSavingNote(actionId);
    try {
      const updated = await saveActionNote(project.id, actionId, notes[actionId] || "");
      setNotes(updated);
    } catch (err) {
      console.error("Failed to save note:", err);
    } finally {
      setSavingNote(null);
    }
  }

  // Pre-resolve prompt bodies for the tab
  const resolvedBodies: Record<string, string> = {};
  for (const prompt of prompts) {
    resolvedBodies[prompt.id] = resolvePrompt(prompt.body, {
      project,
      lastSession,
      issues: workItems,
    });
  }

  if (loading) {
    return (
      <Card className="animate-pulse">
        <div className="h-32" />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Project header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground font-mono">
            {currentProject.name}
          </h1>
          <p className="text-sm text-muted mt-1 max-w-xl">
            {currentProject.description}
          </p>
          {currentProject.stack && (
            <p className="text-xs text-muted mt-1 font-mono">{currentProject.stack}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {currentProject.githubRepo && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-xs text-muted hover:text-accent transition-colors disabled:opacity-50 cursor-pointer"
              title="Sync from GitHub"
            >
              {syncing ? "Syncing..." : "Sync"}
            </button>
          )}
          <Badge variant={PHASE_BADGE_VARIANTS[currentProject.phase]}>{currentProject.phase}</Badge>
        </div>
      </div>

      {/* Quick links + data sources */}
      <div className="flex flex-wrap gap-3 items-center">
        {project.githubRepo && (
          <a
            href={`https://github.com/${project.githubRepo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-accent hover:underline"
          >
            GitHub: {project.githubRepo}
          </a>
        )}
        {project.netlifySiteUrl && (
          <a
            href={project.netlifySiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-accent hover:underline"
          >
            Site: {project.netlifySiteUrl}
          </a>
        )}
        <DataSourceCheckboxes
          project={project}
          onUpdate={(updated) => setDataSources(updated.dataSources || [])}
        />
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-2"
            >
              <span className="text-sm text-foreground">{s.text}</span>
              <div className="flex gap-2 shrink-0 ml-3">
                {s.actionRoute ? (
                  <a
                    href={s.actionRoute}
                    className="text-xs text-accent hover:underline"
                  >
                    {s.actionLabel}
                  </a>
                ) : (
                  <span className="text-xs text-muted">{s.actionLabel}</span>
                )}
                <button
                  onClick={async () => {
                    const dismissed = [...(project.dismissedSuggestions || []), s.id];
                    await updateProject(project.id, { dismissedSuggestions: dismissed }).catch(() => {});
                    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
                  }}
                  className="text-xs text-muted hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabbed view */}
      <div>
        <div className="flex border-b border-border mb-0">
          {([
            { key: "session" as Tab, label: "Last Session" },
            { key: "issues" as Tab, label: `Open Items${workItems.length > 0 ? ` (${workItems.length})` : ""}` },
            { key: "actions" as Tab, label: "Next Actions" },
            { key: "prompts" as Tab, label: `Prompts${prompts.length > 0 ? ` (${prompts.length})` : ""}` },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                activeTab === tab.key
                  ? "text-foreground border-b-2 border-accent -mb-px"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <Card className="rounded-t-none border-t-0">
          {activeTab === "session" && (
            <SessionTab lastSession={lastSession} />
          )}
          {activeTab === "issues" && (
            <IssuesTab items={workItems} hasDataSource={(project.dataSources || []).length > 0 || !!project.githubRepo} />
          )}
          {activeTab === "actions" && (
            <ActionsTab
              actions={actions}
              notes={notes}
              savingNote={savingNote}
              onDone={handleActionDone}
              onSkip={handleActionSkip}
              onNoteChange={(id, value) =>
                setNotes((prev) => ({ ...prev, [id]: value }))
              }
              onNoteSave={handleNoteSave}
            />
          )}
          {activeTab === "prompts" && (
            <PromptsTab
              prompts={prompts}
              resolvedBodies={resolvedBodies}
              copiedId={copiedPrompt}
              projectId={project.id}
              onCopy={handleCopyPrompt}
            />
          )}
        </Card>
      </div>

      {/* End Session */}
      <Button variant="secondary" onClick={onEndSession}>
        End Session
      </Button>
    </div>
  );
}

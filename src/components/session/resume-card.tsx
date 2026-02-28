"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconBack, IconGitHub, IconGlobe, IconSparkle } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project, Session, WorkItem, Prompt } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listSessions, getActionNotes, saveActionNote, listPrompts, executeToolAction, listIntegrations, updateProject } from "@/lib/api";
import { resolvePrompt } from "@/lib/resolve-prompt";
import { getToolForCapability } from "@/lib/data-sources";
import { generateSuggestions, type ProjectSuggestion } from "@/lib/suggestions";
import { SessionTab } from "./session-tab";
import { IssuesTab } from "./issues-tab";
import { ActionsTab } from "./actions-tab";
import { PromptsTab } from "./prompts-tab";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
}

type Tab = "session" | "items" | "actions" | "prompts";

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

        const ctx: ActionContext = { project, lastSession: last, workItems: items };
        setActions(generateNextActions(ctx));

        listIntegrations()
          .then((integrations) => {
            const connected = integrations.filter((i) => i.status === "connected").map((i) => i.id);
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
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, done: true } : a)));
  }

  function handleActionSkip(id: string) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, skipped: true } : a)));
  }

  async function handleCopyPrompt(prompt: Prompt) {
    const resolved = resolvePrompt(prompt.body, { project, lastSession, issues: workItems });
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

  function handleDataSourceUpdate(updated: Project) {
    setDataSources(updated.dataSources || []);
  }

  const resolvedBodies: Record<string, string> = {};
  for (const prompt of prompts) {
    resolvedBodies[prompt.id] = resolvePrompt(prompt.body, { project, lastSession, issues: workItems });
  }

  const tabs = [
    { id: "session" as Tab, label: "Last Session" },
    { id: "items" as Tab, label: "Open Items" },
    { id: "actions" as Tab, label: "Next Actions" },
    { id: "prompts" as Tab, label: "Prompts" },
  ];

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-8 w-48 bg-zinc-800/50 rounded mb-4" />
        <div className="h-32 bg-zinc-900/30 rounded-xl border border-zinc-800/60" />
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/"
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-4 transition-colors"
      >
        <IconBack size={14} /> Dashboard
      </Link>

      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-lg font-semibold text-zinc-100 font-mono">
              {currentProject.name}
            </span>
            <Badge color={PHASE_COLORS[currentProject.phase]}>
              {currentProject.phase}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            {currentProject.stack && <span>{currentProject.stack}</span>}
            {currentProject.githubRepo && (
              <a
                href={`https://github.com/${currentProject.githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-zinc-300 transition-colors"
              >
                <IconGitHub size={12} /> {currentProject.githubRepo}
              </a>
            )}
            {currentProject.netlifySiteUrl && (
              <a
                href={currentProject.netlifySiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-zinc-300 transition-colors"
              >
                <IconGlobe size={12} /> Site
              </a>
            )}
            {currentProject.githubRepo && (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="hover:text-zinc-300 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {syncing ? "Syncing..." : "Sync"}
              </button>
            )}
          </div>
        </div>
        <Button size="sm" onClick={onEndSession}>End Session</Button>
      </div>

      {suggestions.slice(0, 2).map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between px-3 py-2 mb-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-200 text-[13px]"
        >
          <span className="flex items-center gap-2">
            <span className="text-amber-400">&#128161;</span>
            {s.text}
          </span>
          <span className="flex gap-1.5">
            {s.actionRoute ? (
              <a
                href={s.actionRoute}
                className="px-2.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 text-xs font-medium transition-colors"
              >
                Do it
              </a>
            ) : (
              <span className="px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-100 text-xs font-medium">
                {s.actionLabel}
              </span>
            )}
            <button
              onClick={async () => {
                const dismissed = [...(project.dismissedSuggestions || []), s.id];
                await updateProject(project.id, { dismissedSuggestions: dismissed }).catch(() => {});
                setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
              }}
              className="px-2 py-0.5 rounded hover:bg-white/5 text-amber-300/50 text-xs transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}

      {lastSession?.detectedIntent && (
        <div className="flex items-center gap-2 mb-3 px-3 py-1.5 rounded-lg bg-purple-500/5 border border-purple-500/15">
          <span className="text-purple-400"><IconSparkle size={14} /></span>
          <span className="text-xs text-purple-300/80">
            You were working on: <strong className="text-purple-200">{lastSession.detectedIntent}</strong>
          </span>
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-zinc-800/60">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer ${
              activeTab === t.id
                ? "text-zinc-200 border-purple-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="animate-fadeIn">
        {activeTab === "session" && <SessionTab lastSession={lastSession} />}
        {activeTab === "items" && (
          <IssuesTab
            items={workItems}
            hasDataSource={(project.dataSources || []).length > 0 || !!project.githubRepo}
            project={project}
            onDataSourceUpdate={handleDataSourceUpdate}
          />
        )}
        {activeTab === "actions" && (
          <ActionsTab
            actions={actions}
            notes={notes}
            savingNote={savingNote}
            onDone={handleActionDone}
            onSkip={handleActionSkip}
            onNoteChange={(id, value) => setNotes((prev) => ({ ...prev, [id]: value }))}
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
      </div>
    </div>
  );
}

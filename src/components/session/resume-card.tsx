"use client";

import { useState, useEffect, useMemo } from "react";
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
import "./resume-card.css";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
}

type Tab = "session" | "items" | "actions" | "prompts";

export function ResumeCard({ project, onEndSession }: ResumeCardProps) {
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [dataSources] = useState<string[]>(project.dataSources || (project.githubRepo ? ["github"] : []));
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
        // TODO: Consider typed API wrappers to avoid type assertions on executeToolAction results
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

  const resolvedBodies = useMemo(() => {
    const bodies: Record<string, string> = {};
    for (const prompt of prompts) {
      bodies[prompt.id] = resolvePrompt(prompt.body, { project, lastSession, issues: workItems });
    }
    return bodies;
  }, [prompts, project, lastSession, workItems]);

  const tabs = [
    { id: "session" as Tab, label: "Last Session" },
    { id: "items" as Tab, label: "Open Items" },
    { id: "actions" as Tab, label: "Next Actions" },
    { id: "prompts" as Tab, label: "Prompts" },
  ];

  if (loading) {
    return (
      <div className="resume-card__skeleton">
        <div className="resume-card__skeleton-bar" />
        <div className="resume-card__skeleton-block" />
      </div>
    );
  }

  return (
    <div>
      <Link href="/" className="resume-card__back">
        <IconBack size={14} /> Dashboard
      </Link>

      <div className="resume-card__header">
        <div>
          <div className="resume-card__name-row">
            <span className="resume-card__name">
              {currentProject.name}
            </span>
            <Badge color={PHASE_COLORS[currentProject.phase]}>
              {currentProject.phase}
            </Badge>
          </div>
          <div className="resume-card__meta">
            {currentProject.stack && <span>{currentProject.stack}</span>}
            {currentProject.githubRepo && (
              <a
                href={`https://github.com/${currentProject.githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="resume-card__meta-link"
              >
                <IconGitHub size={12} /> {currentProject.githubRepo}
              </a>
            )}
            {currentProject.netlifySiteUrl && (
              <a
                href={currentProject.netlifySiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="resume-card__meta-link"
              >
                <IconGlobe size={12} /> Site
              </a>
            )}
            {currentProject.githubRepo && (
              <button
                onClick={handleSync}
                disabled={syncing}
                className="resume-card__sync-btn"
              >
                {syncing ? "Syncing..." : "Sync"}
              </button>
            )}
          </div>
        </div>
        <Button size="sm" onClick={onEndSession}>End Session</Button>
      </div>

      {suggestions.slice(0, 2).map((s) => (
        <div key={s.id} className="resume-card__suggestion">
          <span className="resume-card__suggestion-text">
            <span className="resume-card__suggestion-icon">&#128161;</span>
            {s.text}
          </span>
          <span className="resume-card__suggestion-actions">
            {s.actionRoute ? (
              <a href={s.actionRoute} className="resume-card__suggestion-action">
                Do it
              </a>
            ) : (
              <span className="resume-card__suggestion-label">
                {s.actionLabel}
              </span>
            )}
            <button
              onClick={async () => {
                const dismissed = [...(project.dismissedSuggestions || []), s.id];
                await updateProject(project.id, { dismissedSuggestions: dismissed }).catch(() => {});
                setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
              }}
              className="resume-card__suggestion-dismiss"
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}

      {lastSession?.detectedIntent && (
        <div className="resume-card__intent">
          <span className="resume-card__intent-icon"><IconSparkle size={14} /></span>
          <span className="resume-card__intent-text">
            You were working on: <strong className="resume-card__intent-label">{lastSession.detectedIntent}</strong>
          </span>
        </div>
      )}

      <div className="resume-card__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`resume-card__tab ${
              activeTab === t.id
                ? "resume-card__tab--active"
                : "resume-card__tab--inactive"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="resume-card__tab-content">
        {activeTab === "session" && <SessionTab lastSession={lastSession} />}
        {activeTab === "items" && (
          <IssuesTab
            items={workItems}
            hasDataSource={(project.dataSources || []).length > 0 || !!project.githubRepo}
            project={project}

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

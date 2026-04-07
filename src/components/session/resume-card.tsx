"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconBack, IconGitHub, IconGlobe, IconSparkle } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project, Session } from "@/lib/types";
import type { ManualActionData } from "@/lib/api";
import { listProjects, listSessions, executeToolAction, listIntegrations, updateProject, listManualActions, addManualAction, updateManualAction, deleteManualAction, reorderManualActions, paraphraseText } from "@/lib/api";
import { timeAgo, formatDayDate } from "@/lib/format";
import { generateSuggestions, type ProjectSuggestion } from "@/lib/suggestions";
import { computeProjectHealth, type ProjectHealth } from "@/lib/project-health";
import { useProvider } from "@/context/provider-context";
import { SessionTab } from "./session-tab";
import { ActionsTab } from "./actions-tab";
import { DevTab } from "./dev-tab";
import { DocTab } from "./doc-tab";
import { ToolsTab } from "./tools-tab";
import "./resume-card.css";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
  onActionsChange?: (actions: ManualActionData[]) => void;
}

type Tab = "session" | "actions" | "dev" | "doc" | "tools";

export function ResumeCard({ project, onEndSession, onActionsChange }: ResumeCardProps) {
  const router = useRouter();
  const { selected: selectedProvider } = useProvider();
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [actions, setActions] = useState<ManualActionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("actions");
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [currentProject, setCurrentProject] = useState(project);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [healthMap, setHealthMap] = useState<Record<string, ProjectHealth>>({});
  const [lastCommitDate, setLastCommitDate] = useState<string | null>(null);

  async function handleDismissSuggestion(id: string) {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
    const dismissed = [...(currentProject.dismissedSuggestions || []), id];
    try {
      await updateProject(currentProject.id, { dismissedSuggestions: dismissed });
      setCurrentProject((p) => ({ ...p, dismissedSuggestions: dismissed }));
    } catch (err) {
      console.error("Failed to dismiss suggestion:", err);
    }
  }

  async function handleSync() {
    if (!currentProject.githubRepo || syncing) return;
    const [owner, repo] = currentProject.githubRepo.split("/");
    setSyncing(true);
    try {
      const analyzeRes = await executeToolAction("github_analyze_repo", { owner, repo });
      const updates: Partial<Project> = { lastSyncedAt: new Date().toISOString() };
      if (analyzeRes.ok && analyzeRes.result) {
        const analysis = analyzeRes.result as {
          name?: string;
          fullName?: string;
          detectedStack?: string;
          detectedPhase?: "idea" | "mvp" | "polish" | "deploy";
          description?: string;
        };
        if (analysis.name) updates.name = analysis.name;
        if (analysis.fullName && analysis.fullName !== currentProject.githubRepo) {
          updates.githubRepo = analysis.fullName;
        }
        if (analysis.detectedStack) updates.stack = analysis.detectedStack;
        if (analysis.detectedPhase) updates.phase = analysis.detectedPhase;
        if (analysis.description) updates.description = analysis.description;
      }
      const updated = await updateProject(currentProject.id, updates);
      setCurrentProject(updated);
      setAllProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...p, name: updated.name } : p))
      );
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    onActionsChange?.(actions);
  }, [actions, onActionsChange]);

  useEffect(() => {
    async function load() {
      try {
        const [sessions, manualItems] = await Promise.all([
          listSessions(project.id),
          listManualActions(project.id).catch(() => []),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setActions(manualItems);

        listIntegrations()
          .then((integrations) => {
            const connected = integrations.filter((i) => i.status === "connected").map((i) => i.id);
            setSuggestions(generateSuggestions(project, last, connected));
          })
          .catch(() => setSuggestions([]));

        listProjects()
          .then(async (projects) => {
            setAllProjects(projects);
            const entries = await Promise.all(
              projects.map(async (p) => {
                const [sessions, commitDate] = await Promise.all([
                  listSessions(p.id).catch(() => []),
                  p.githubRepo
                    ? executeToolAction("github_list_commits", {
                        owner: p.githubRepo.split("/")[0],
                        repo: p.githubRepo.split("/")[1],
                        limit: 1,
                      })
                        .then((res) =>
                          res.ok && Array.isArray(res.result) && res.result.length > 0
                            ? (res.result[0].date as string)
                            : null
                        )
                        .catch(() => null)
                    : Promise.resolve(null),
                ]);
                if (p.id === project.id && commitDate) {
                  setLastCommitDate(commitDate);
                }
                return [p.id, computeProjectHealth(p.id, sessions, p.lastSyncedAt, commitDate)] as const;
              })
            );
            setHealthMap(Object.fromEntries(entries));
          })
          .catch(() => {});
      } catch {
        setActions([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [project]);

  function handleActionDone(id: string) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, done: true } : a)));
    updateManualAction(project.id, id, { done: true }).catch(() => {});
  }

  async function handleAddManual(text: string) {
    const id = `manual-${Date.now()}`;
    const newAction: ManualActionData = { id, text, done: false, createdAt: new Date().toISOString() };
    setActions((prev) => [newAction, ...prev]);
    try {
      await addManualAction(project.id, id, text);
    } catch (err) {
      console.error("Failed to save manual action:", err);
      setActions((prev) => prev.filter((a) => a.id !== id));
    }
  }

  async function handleParaphrase(text: string, persona?: string): Promise<string | null> {
    try {
      const result = await paraphraseText(text, selectedProvider, persona);
      return result.text || null;
    } catch (err) {
      console.error("Paraphrase failed:", err);
      return null;
    }
  }

  async function handleEditManual(id: string, text: string) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, text } : a)));
    try {
      await updateManualAction(project.id, id, { text });
    } catch (err) {
      console.error("Failed to edit manual action:", err);
    }
  }

  async function handleDeleteManual(id: string) {
    setActions((prev) => prev.filter((a) => a.id !== id));
    try {
      const remaining = await deleteManualAction(project.id, id);
      setActions(remaining);
    } catch (err) {
      console.error("Failed to delete manual action:", err);
    }
  }

  function handleReorder(fromIndex: number, toIndex: number) {
    setActions((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      const ids = next.map((a) => a.id);
      reorderManualActions(project.id, ids).catch(() => {});
      return next;
    });
  }

  const tabs = [
    { id: "actions" as Tab, label: "Next Actions" },
    { id: "session" as Tab, label: "Last Session" },
    { id: "dev" as Tab, label: ".dev" },
    { id: "doc" as Tab, label: ".doc" },
    { id: "tools" as Tab, label: "Tools" },
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

      {allProjects.length > 1 && (
        <nav className="resume-card__project-nav">
          {allProjects.map((p) => {
            const health = healthMap[p.id];
            return (
              <button
                key={p.id}
                onClick={() => router.push(`/project/${p.id}`)}
                className={`resume-card__project-nav-item ${
                  p.id === project.id ? "resume-card__project-nav-item--active" : ""
                }`}
              >
                <span
                  className={`resume-card__health-dot ${
                    health
                      ? health.needsAttention
                        ? "resume-card__health-dot--attention"
                        : "resume-card__health-dot--good"
                      : ""
                  }`}
                />
                {p.name}
              </button>
            );
          })}
        </nav>
      )}

      <div className="resume-card__header">
        <div className="resume-card__activity-stamps">
          {lastSession && (
            <span className="resume-card__stamp">
              Last session: {formatDayDate(lastSession.createdAt)} ({timeAgo(lastSession.createdAt)})
            </span>
          )}
          {lastCommitDate && (
            <span className="resume-card__stamp">
              Last commit: {formatDayDate(lastCommitDate)} ({timeAgo(lastCommitDate)})
            </span>
          )}
        </div>
        <div className="resume-card__name-row">
          <h1 className="resume-card__title">{currentProject.name}</h1>
          <Badge color={PHASE_COLORS[currentProject.phase]}>
            {currentProject.phase}
          </Badge>
        </div>
        {currentProject.description && (
          <div className="resume-card__description">{currentProject.description}</div>
        )}
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
            <>
              {currentProject.lastSyncedAt && (
                <span className="resume-card__last-sync">Last sync {timeAgo(currentProject.lastSyncedAt)}</span>
              )}
              <button
                onClick={handleSync}
                disabled={syncing}
                className="resume-card__sync-btn"
              >
                {syncing ? "Syncing..." : "Sync"}
              </button>
            </>
          )}
        </div>
        <div className="resume-card__header-actions">
          <Button size="sm" onClick={onEndSession}>End Session</Button>
        </div>
      </div>

      {suggestions.slice(0, 2).map((s) => (
        <div key={s.id} className="resume-card__suggestion">
          <span className="resume-card__suggestion-text">
            <span className="resume-card__suggestion-icon">&#128161;</span>
            {s.text}
          </span>
          <div className="resume-card__suggestion-buttons">
            {s.actionRoute === "#tools-tab" ? (
              <button onClick={() => setActiveTab("tools")} className="resume-card__suggestion-action">
                {s.actionLabel}
              </button>
            ) : s.actionRoute ? (
              <a href={s.actionRoute} className="resume-card__suggestion-action">
                {s.actionLabel}
              </a>
            ) : (
              <button onClick={onEndSession} className="resume-card__suggestion-action">
                {s.actionLabel}
              </button>
            )}
            <button onClick={() => handleDismissSuggestion(s.id)} className="resume-card__suggestion-dismiss">
              Dismiss
            </button>
          </div>
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
        {activeTab === "actions" && (
          <ActionsTab
            actions={actions}
            onDone={handleActionDone}
            onAddManual={handleAddManual}
            onDeleteManual={handleDeleteManual}
            onEditManual={handleEditManual}
            onParaphrase={handleParaphrase}
            onReorder={handleReorder}
          />
        )}
        {activeTab === "session" && <SessionTab lastSession={lastSession} />}
        {activeTab === "dev" && <DevTab project={currentProject} />}
        {activeTab === "doc" && <DocTab project={currentProject} />}
        {activeTab === "tools" && <ToolsTab />}
      </div>
    </div>
  );
}

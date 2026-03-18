"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconBack, IconGitHub, IconGlobe, IconSparkle, IconLayers } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project, Session, TechDebtScan } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listProjects, listSessions, getActionNotes, saveActionNote, executeToolAction, listIntegrations, updateProject, listManualActions, addManualAction, updateManualAction, deleteManualAction, paraphraseText } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { generateSuggestions, type ProjectSuggestion } from "@/lib/suggestions";
import { useProvider } from "@/context/provider-context";
import { SessionTab } from "./session-tab";
import { ActionsTab } from "./actions-tab";
import { PromptsTab } from "./prompts-tab";
import { TechDebtGrid } from "./tech-debt-grid";
import { ToolsTab } from "./tools-tab";
import "./resume-card.css";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
  onActionsChange?: (actions: NextAction[]) => void;
}

type Tab = "session" | "actions" | "prompts" | "tech-debt" | "tools";

export function ResumeCard({ project, onEndSession, onActionsChange }: ResumeCardProps) {
  const router = useRouter();
  const { selected: selectedProvider } = useProvider();
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("actions");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [currentProject, setCurrentProject] = useState(project);
  const [allProjects, setAllProjects] = useState<Project[]>([]);

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
      const [analyzeRes, debtRes] = await Promise.all([
        executeToolAction("github_analyze_repo", { owner, repo }),
        executeToolAction("github_scan_tech_debt", { owner, repo }),
      ]);
      const updates: Partial<Project> = { lastSyncedAt: new Date().toISOString() };
      if (analyzeRes.ok && analyzeRes.result) {
        const analysis = analyzeRes.result as {
          detectedStack?: string;
          detectedPhase?: "idea" | "mvp" | "polish" | "deploy";
          description?: string;
        };
        if (analysis.detectedStack) updates.stack = analysis.detectedStack;
        if (analysis.detectedPhase) updates.phase = analysis.detectedPhase;
        if (analysis.description) updates.description = analysis.description;
      }
      if (debtRes.ok && debtRes.result) {
        updates.techDebt = debtRes.result as TechDebtScan;
      }
      const updated = await updateProject(currentProject.id, updates);
      setCurrentProject(updated);
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
        const [sessions, savedNotes, manualItems] = await Promise.all([
          listSessions(project.id),
          getActionNotes(project.id).catch(() => ({} as Record<string, string>)),
          listManualActions(project.id).catch(() => []),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setNotes(savedNotes);

        const ctx: ActionContext = { project, lastSession: last };
        const generated = generateNextActions(ctx);
        const manual: NextAction[] = manualItems.map((m) => ({
          id: m.id,
          text: m.text,
          done: m.done,
          skipped: false,
          source: "manual" as const,
        }));
        setActions([...manual.reverse(), ...generated]);

        listIntegrations()
          .then((integrations) => {
            const connected = integrations.filter((i) => i.status === "connected").map((i) => i.id);
            setSuggestions(generateSuggestions(project, last, connected));
          })
          .catch(() => setSuggestions([]));

        listProjects()
          .then((p) => setAllProjects(p))
          .catch(() => {});
      } catch {
        setActions(generateNextActions({ project, lastSession: null }));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [project]);

  function handleActionDone(id: string) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, done: true } : a)));
    // Persist done state for manual actions
    const action = actions.find((a) => a.id === id);
    if (action?.source === "manual") {
      updateManualAction(project.id, id, { done: true }).catch(() => {});
    }
  }

  function handleActionSkip(id: string) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, skipped: true } : a)));
  }

  async function handleAddManual(text: string) {
    const id = `manual-${Date.now()}`;
    const newAction: NextAction = { id, text, done: false, skipped: false, source: "manual" };
    setActions((prev) => [newAction, ...prev]);
    try {
      await addManualAction(project.id, id, text);
    } catch (err) {
      console.error("Failed to save manual action:", err);
      setActions((prev) => prev.filter((a) => a.id !== id));
    }
  }

  async function handleParaphrase(text: string): Promise<string | null> {
    try {
      const result = await paraphraseText(text, selectedProvider);
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
      await deleteManualAction(project.id, id);
    } catch (err) {
      console.error("Failed to delete manual action:", err);
    }
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

  const tabs = [
    { id: "actions" as Tab, label: "Next Actions" },
    { id: "session" as Tab, label: "Last Session" },
    ...(currentProject.techDebt?.summary?.length ? [{ id: "tech-debt" as Tab, label: "Tech Debt" }] : []),
    { id: "prompts" as Tab, label: "Prompts" },
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
          {allProjects.map((p) => (
            <button
              key={p.id}
              onClick={() => router.push(`/project/${p.id}`)}
              className={`resume-card__project-nav-item ${
                p.id === project.id ? "resume-card__project-nav-item--active" : ""
              }`}
            >
              {p.name}
            </button>
          ))}
        </nav>
      )}

      <div className="resume-card__header">
        <div className="resume-card__name-row">
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
          {currentProject.githubRepo && (
            <Link href={`/dev-folder/${currentProject.id}`}>
              <Button size="sm" variant="secondary"><IconLayers size={14} /> .dev/</Button>
            </Link>
          )}
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
            {s.actionRoute === "#tools-tab" || s.actionRoute === "#prompts-tab" ? (
              <button onClick={() => setActiveTab(s.actionRoute === "#tools-tab" ? "tools" : "prompts")} className="resume-card__suggestion-action">
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
            notes={notes}
            savingNote={savingNote}
            onDone={handleActionDone}
            onSkip={handleActionSkip}
            onNoteChange={(id, value) => setNotes((prev) => ({ ...prev, [id]: value }))}
            onNoteSave={handleNoteSave}
            onAddManual={handleAddManual}
            onDeleteManual={handleDeleteManual}
            onEditManual={handleEditManual}
            onParaphrase={handleParaphrase}
          />
        )}
        {activeTab === "session" && <SessionTab lastSession={lastSession} />}
        {activeTab === "tech-debt" && currentProject.techDebt && (
          <TechDebtGrid
            summary={currentProject.techDebt.summary}
            scannedAt={currentProject.techDebt.scannedAt}
          />
        )}
        {activeTab === "prompts" && (
          <PromptsTab
            project={project}
            lastSession={lastSession}
          />
        )}
        {activeTab === "tools" && <ToolsTab />}
      </div>
    </div>
  );
}

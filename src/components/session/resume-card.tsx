"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Project, Session, GitHubIssue, Prompt } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listSessions, getIssues, getActionNotes, saveActionNote, listPrompts } from "@/lib/api";
import { resolvePrompt } from "@/lib/resolve-prompt";
import { PHASE_BADGE_VARIANTS } from "@/lib/constants";
import { SessionTab } from "./session-tab";
import { IssuesTab } from "./issues-tab";
import { ActionsTab } from "./actions-tab";
import { PromptsTab } from "./prompts-tab";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
}

type Tab = "session" | "issues" | "actions" | "prompts";

export function ResumeCard({ project, onEndSession }: ResumeCardProps) {
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [sessions, fetchedIssues, savedNotes, fetchedPrompts] = await Promise.all([
          listSessions(project.id),
          project.githubRepo
            ? getIssues(project.githubRepo).catch(() => [] as GitHubIssue[])
            : Promise.resolve([] as GitHubIssue[]),
          getActionNotes(project.id).catch(() => ({} as Record<string, string>)),
          listPrompts(project.id).catch(() => [] as Prompt[]),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setIssues(fetchedIssues);
        setNotes(savedNotes);
        setPrompts(fetchedPrompts);

        const ctx: ActionContext = {
          project,
          lastSession: last,
          issues: fetchedIssues,
        };
        setActions(generateNextActions(ctx));
      } catch {
        setActions(generateNextActions({ project, lastSession: null }));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [project]);

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
      issues,
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
      issues,
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
            {project.name}
          </h1>
          <p className="text-sm text-muted mt-1 max-w-xl">
            {project.description}
          </p>
        </div>
        <Badge variant={PHASE_BADGE_VARIANTS[project.phase]}>{project.phase}</Badge>
      </div>

      {/* Quick links */}
      <div className="flex gap-3">
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
      </div>

      {/* Tabbed view */}
      <div>
        <div className="flex border-b border-border mb-0">
          {([
            { key: "session" as Tab, label: "Last Session" },
            { key: "issues" as Tab, label: `Open Issues${issues.length > 0 ? ` (${issues.length})` : ""}` },
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
            <IssuesTab issues={issues} hasRepo={!!project.githubRepo} />
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

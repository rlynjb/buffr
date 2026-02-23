"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Project, Session, GitHubIssue } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listSessions, getIssues, getActionNotes, saveActionNote } from "@/lib/api";

interface ResumeCardProps {
  project: Project;
  onEndSession: () => void;
}

const phaseBadge: Record<string, "default" | "accent" | "warning" | "success"> = {
  idea: "default",
  mvp: "accent",
  polish: "warning",
  deploy: "success",
};

type Tab = "session" | "issues" | "actions";

export function ResumeCard({ project, onEndSession }: ResumeCardProps) {
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("session");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [sessions, fetchedIssues, savedNotes] = await Promise.all([
          listSessions(project.id),
          project.githubRepo
            ? getIssues(project.githubRepo).catch(() => [] as GitHubIssue[])
            : Promise.resolve([] as GitHubIssue[]),
          getActionNotes(project.id).catch(() => ({} as Record<string, string>)),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setIssues(fetchedIssues);
        setNotes(savedNotes);

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
        <Badge variant={phaseBadge[project.phase]}>{project.phase}</Badge>
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

      {/* Tabbed view: Last Session / Open Issues / Next Actions */}
      <div>
        <div className="flex border-b border-border mb-0">
          {([
            { key: "session" as Tab, label: "Last Session" },
            { key: "issues" as Tab, label: `Open Issues${issues.length > 0 ? ` (${issues.length})` : ""}` },
            { key: "actions" as Tab, label: "Next Actions" },
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
          {/* Last Session tab */}
          {activeTab === "session" && (
            <>
              {lastSession ? (
                <div className="space-y-2 text-sm">
                  {lastSession.goal && (
                    <div>
                      <span className="text-muted">Goal: </span>
                      <span className="text-foreground">{lastSession.goal}</span>
                    </div>
                  )}
                  {lastSession.nextStep && (
                    <div>
                      <span className="text-muted">Next: </span>
                      <span className="text-foreground">{lastSession.nextStep}</span>
                    </div>
                  )}
                  {lastSession.blockers && (
                    <div>
                      <span className="text-error">Blocked: </span>
                      <span className="text-foreground">{lastSession.blockers}</span>
                    </div>
                  )}
                  {lastSession.whatChanged.length > 0 && (
                    <div>
                      <span className="text-muted block mb-1">What changed:</span>
                      <ul className="list-disc list-inside text-foreground space-y-0.5">
                        {lastSession.whatChanged.map((item, i) => (
                          <li key={i} className="text-sm">{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="text-xs text-muted">
                    {new Date(lastSession.createdAt).toLocaleDateString()} at{" "}
                    {new Date(lastSession.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted space-y-1">
                  <p>This is where your last work session will appear. It tracks what you worked on, what changed, what to do next, and any blockers.</p>
                  <p>Click &quot;End Session&quot; below when you&apos;re done working to log your progress.</p>
                </div>
              )}
            </>
          )}

          {/* Open Issues tab */}
          {activeTab === "issues" && (
            <>
              {issues.length > 0 ? (
                <div className="space-y-2">
                  {issues.slice(0, 5).map((issue) => (
                    <div key={issue.number} className="text-sm">
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground hover:text-accent hover:underline"
                      >
                        <span className="text-muted font-mono mr-1.5">
                          #{issue.number}
                        </span>
                        {issue.title}
                      </a>
                      {issue.labels.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {issue.labels.slice(0, 3).map((label) => (
                            <Badge key={label} variant="default">
                              {label}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted space-y-1">
                  {project.githubRepo ? (
                    <p>No open issues on this repository. When issues are created on GitHub, they&apos;ll appear here and feed into your Next Actions.</p>
                  ) : (
                    <p>This is where open GitHub issues will appear. Connect a GitHub repository to pull in issues, which also feed into your Next Actions as suggested tasks.</p>
                  )}
                </div>
              )}
            </>
          )}

          {/* Next Actions tab */}
          {activeTab === "actions" && (
            <div className="space-y-3">
              {actions.map((action) => (
                <div
                  key={action.id}
                  className={`rounded-lg border border-border p-3 ${
                    action.done
                      ? "opacity-50"
                      : action.skipped
                        ? "opacity-30"
                        : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm text-foreground ${action.done ? "line-through" : ""}`}>
                      {action.text}
                    </span>
                    {!action.done && !action.skipped && (
                      <div className="flex gap-2 shrink-0 ml-3">
                        <button
                          onClick={() => handleActionDone(action.id)}
                          className="text-xs text-success hover:underline"
                        >
                          Done
                        </button>
                        <button
                          onClick={() => handleActionSkip(action.id)}
                          className="text-xs text-muted hover:underline"
                        >
                          Skip
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-2">
                    <textarea
                      value={notes[action.id] || ""}
                      onChange={(e) =>
                        setNotes((prev) => ({ ...prev, [action.id]: e.target.value }))
                      }
                      placeholder="Add notes..."
                      rows={2}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent resize-y"
                    />
                    <button
                      onClick={() => handleNoteSave(action.id)}
                      disabled={savingNote === action.id}
                      className="mt-1 text-xs text-accent hover:underline disabled:opacity-50"
                    >
                      {savingNote === action.id ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              ))}
              {actions.length === 0 && (
                <p className="text-sm text-muted">No actions suggested</p>
              )}
            </div>
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

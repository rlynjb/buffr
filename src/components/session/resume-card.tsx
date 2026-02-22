"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Project, Session, GitHubIssue } from "@/lib/types";
import { generateNextActions, type NextAction, type ActionContext } from "@/lib/next-actions";
import { listSessions, getIssues } from "@/lib/api";

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

export function ResumeCard({ project, onEndSession }: ResumeCardProps) {
  const [lastSession, setLastSession] = useState<Session | null>(null);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [sessions, fetchedIssues] = await Promise.all([
          listSessions(project.id),
          project.githubRepo
            ? getIssues(project.githubRepo).catch(() => [] as GitHubIssue[])
            : Promise.resolve([] as GitHubIssue[]),
        ]);

        const last = sessions.length > 0 ? sessions[0] : null;
        setLastSession(last);
        setIssues(fetchedIssues);

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

      {/* Last session */}
      {lastSession && (
        <Card>
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Last Session
          </h3>
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
        </Card>
      )}

      {/* Plan summary */}
      {project.plan && (
        <Card>
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Plan
          </h3>
          <div className="text-sm text-muted mb-2">
            Stack: <span className="font-mono text-foreground">{project.stack}</span>
          </div>
          {project.selectedFeatures && project.selectedFeatures.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {project.selectedFeatures.map((f, i) => (
                <Badge key={i} variant="accent">
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Open Issues */}
      {issues.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-foreground mb-3">
            Open Issues
            <span className="ml-2 text-xs font-normal text-muted">
              ({issues.length})
            </span>
          </h3>
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
        </Card>
      )}

      {/* Next Actions */}
      <Card>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Next Actions
        </h3>
        <div className="space-y-2">
          {actions.map((action) => (
            <div
              key={action.id}
              className={`flex items-center justify-between rounded-lg border border-border p-3 ${
                action.done
                  ? "opacity-50 line-through"
                  : action.skipped
                    ? "opacity-30"
                    : ""
              }`}
            >
              <span className="text-sm text-foreground">{action.text}</span>
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
          ))}
          {actions.length === 0 && (
            <p className="text-sm text-muted">No actions suggested</p>
          )}
        </div>
      </Card>

      {/* End Session */}
      <Button variant="secondary" onClick={onEndSession}>
        End Session
      </Button>
    </div>
  );
}

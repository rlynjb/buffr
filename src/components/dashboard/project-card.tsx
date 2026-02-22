"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Project } from "@/lib/types";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

const phaseBadge: Record<string, "default" | "accent" | "warning" | "success"> = {
  idea: "default",
  mvp: "accent",
  polish: "warning",
  deploy: "success",
};

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const updatedAgo = getTimeAgo(project.updatedAt);

  return (
    <Card hover onClick={onClick}>
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold font-mono text-foreground">
          {project.name}
        </h3>
        <Badge variant={phaseBadge[project.phase]}>{project.phase}</Badge>
      </div>

      {project.stack && (
        <p className="text-xs font-mono text-muted mb-2">{project.stack}</p>
      )}

      {project.description && (
        <p className="text-sm text-muted line-clamp-2 mb-3">
          {project.description}
        </p>
      )}

      <div className="flex items-center gap-4 text-xs text-muted">
        <span>{updatedAgo}</span>
        {project.githubRepo && (
          <span className="font-mono">{project.githubRepo}</span>
        )}
        {project.netlifySiteUrl && (
          <span className="text-success">deployed</span>
        )}
      </div>
    </Card>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

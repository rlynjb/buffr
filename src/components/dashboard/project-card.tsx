"use client";

import { Badge } from "@/components/ui/badge";
import { SourceIcon, IconGitHub, IconGlobe, IconChevron } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project } from "@/lib/types";
import "./project-card.css";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const updatedAgo = getTimeAgo(project.updatedAt);

  return (
    <button onClick={onClick} className="project-card">
      <div className="project-card__body">
        <div className="project-card__name-row">
          <span className="project-card__name">
            {project.name}
          </span>
          <Badge color={PHASE_COLORS[project.phase]}>{project.phase}</Badge>
          {project.dataSources?.map((ds) => (
            <span key={ds} className="project-card__source-icon">
              <SourceIcon source={ds} size={12} />
            </span>
          ))}
        </div>
        <div className="project-card__meta">
          {project.stack && <span>{project.stack}</span>}
          <span>·</span>
          <span>{updatedAgo}</span>
        </div>
      </div>
      <div className="project-card__actions">
        {project.githubRepo && (
          <span className="project-card__actions-icon"><IconGitHub size={14} /></span>
        )}
        {project.netlifySiteUrl && (
          <span className="project-card__actions-icon"><IconGlobe size={14} /></span>
        )}
        <span className="project-card__actions-chevron"><IconChevron size={12} /></span>
      </div>
    </button>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

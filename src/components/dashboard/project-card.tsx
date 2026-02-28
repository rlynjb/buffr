"use client";

import { Badge } from "@/components/ui/badge";
import { SourceIcon, IconGitHub, IconGlobe, IconChevron } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import "./project-card.css";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const updatedAgo = timeAgo(project.updatedAt);

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

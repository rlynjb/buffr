"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { SourceIcon, IconGitHub, IconGlobe, IconChevron, IconTrash, IconLayers } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { listSessions, listManualActions } from "@/lib/api";
import { generateNextActions, type NextAction } from "@/lib/next-actions";
import "./project-card.css";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  onDelete: (project: Project) => void;
}

export function ProjectCard({ project, onClick, onDelete }: ProjectCardProps) {
  const updatedAgo = timeAgo(project.updatedAt);
  const [actions, setActions] = useState<NextAction[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const [sessions, manualItems] = await Promise.all([
          listSessions(project.id),
          listManualActions(project.id).catch(() => []),
        ]);
        const last = sessions.length > 0 ? sessions[0] : null;
        const generated = generateNextActions({ project, lastSession: last });
        const manual: NextAction[] = manualItems.map((m) => ({
          id: m.id,
          text: m.text,
          done: m.done,
          skipped: false,
          source: "manual" as const,
        }));
        setActions([...generated, ...manual].filter((a) => !a.done));
      } catch {
        // Silent — card still renders without actions
      }
    }
    load();
  }, [project]);

  return (
    <div onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }} className="project-card">
      <div className="project-card__body">
        <div className="project-card__name-row">
          <span className="project-card__name">
            {project.name}
          </span>
          <Badge color={PHASE_COLORS[project.phase]}>{project.phase}</Badge>
          {project.devFolder && (
            <span className="project-card__dev-icon" title=".dev/ generated">
              <IconLayers size={12} />
            </span>
          )}
          {project.dataSources?.map((ds) => (
            <span key={ds} className="project-card__source-icon">
              <SourceIcon source={ds} size={12} />
            </span>
          ))}
        </div>
        {project.description && (
          <div className="project-card__description">{project.description}</div>
        )}
        <div className="project-card__meta">
          {project.stack && <span>{project.stack}</span>}
          <span>·</span>
          <span>{updatedAgo}</span>
        </div>
        {actions.length > 0 && (
          <div className="project-card__actions-list">
            <span className="project-card__actions-title">Next Actions</span>
            <ul className="project-card__actions-items">
              {actions.slice(0, 3).map((a) => (
                <li key={a.id} className="project-card__action-item">{a.text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="project-card__actions">
        {project.githubRepo && (
          <span className="project-card__actions-icon"><IconGitHub size={14} /></span>
        )}
        {project.netlifySiteUrl && (
          <span className="project-card__actions-icon"><IconGlobe size={14} /></span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(project); }}
          className="project-card__actions-delete"
          aria-label={`Delete ${project.name}`}
        >
          <IconTrash size={13} />
        </button>
        <span className="project-card__actions-chevron"><IconChevron size={12} /></span>
      </div>
    </div>
  );
}

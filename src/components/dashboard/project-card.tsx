"use client";

import { Badge } from "@/components/ui/badge";
import { SourceIcon, IconGitHub, IconGlobe, IconChevron } from "@/components/icons";
import { PHASE_COLORS } from "@/lib/constants";
import type { Project } from "@/lib/types";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const updatedAgo = getTimeAgo(project.updatedAt);

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-800/30 hover:border-zinc-700/60 transition-all text-left group cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="text-sm font-medium text-zinc-200 font-mono">
            {project.name}
          </span>
          <Badge color={PHASE_COLORS[project.phase]}>{project.phase}</Badge>
          {project.dataSources?.map((ds) => (
            <span key={ds} className="opacity-50">
              <SourceIcon source={ds} size={12} />
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-zinc-500">
          {project.stack && <span>{project.stack}</span>}
          <span>·</span>
          <span>{updatedAgo}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {project.githubRepo && (
          <span className="text-zinc-500"><IconGitHub size={14} /></span>
        )}
        {project.netlifySiteUrl && (
          <span className="text-zinc-500"><IconGlobe size={14} /></span>
        )}
        <span className="text-zinc-600"><IconChevron size={12} /></span>
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

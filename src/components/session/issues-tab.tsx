"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SourceIcon, sourceColor } from "@/components/icons";
import { IconLink } from "@/components/icons";
import type { WorkItem, Project } from "@/lib/types";
import { DataSourceCheckboxes } from "./data-source-checkboxes";

interface IssuesTabProps {
  items: WorkItem[];
  hasDataSource: boolean;
  project: Project;
  onDataSourceUpdate: (updated: Project) => void;
}

export function IssuesTab({ items, hasDataSource, project, onDataSourceUpdate }: IssuesTabProps) {
  const [enabledSources, setEnabledSources] = useState<string[]>(
    project.dataSources || (project.githubRepo ? ["github"] : [])
  );

  const filtered = items.filter((item) => enabledSources.includes(item.source));

  return (
    <div>
      {/* Filter row */}
      <div className="flex items-center gap-3 pb-3 mb-3 border-b border-zinc-800/50">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Filter</span>
        {["github", "jira", "notion"].map((s) => (
          <label key={s} className="flex items-center gap-1.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={enabledSources.includes(s)}
              onChange={() =>
                setEnabledSources((prev) =>
                  prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                )
              }
              className="accent-purple-500 w-3 h-3"
            />
            <span
              className="flex items-center gap-1 text-[11px] group-hover:opacity-100 transition-opacity"
              style={{
                color: enabledSources.includes(s) ? sourceColor(s) : "#555",
                opacity: enabledSources.includes(s) ? 1 : 0.5,
              }}
            >
              <SourceIcon source={s} size={12} />
              <span className="capitalize">{s}</span>
            </span>
          </label>
        ))}
        <span className="text-[10px] text-zinc-700 ml-auto">
          {filtered.length} item{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Data source management (hidden behind checkbox state) */}
      <div className="hidden">
        <DataSourceCheckboxes project={project} onUpdate={onDataSourceUpdate} />
      </div>

      {/* Items list */}
      {filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-zinc-600">
          {hasDataSource
            ? "No open items from enabled sources."
            : "Connect a data source like GitHub, Notion, or Jira to pull in issues and tasks."}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.slice(0, 15).map((item) => (
            <a
              key={`${item.source}-${item.id}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.02] transition-colors group cursor-pointer no-underline"
            >
              <span style={{ color: sourceColor(item.source) }}>
                <SourceIcon source={item.source} size={14} />
              </span>
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 flex-1 transition-colors">
                {item.title}
              </span>
              <span className="text-xs text-zinc-600 font-mono">{item.id}</span>
              {item.labels?.slice(0, 3).map((l) => (
                <Badge key={l} color="#666" small>
                  {l}
                </Badge>
              ))}
              <span className="text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">
                <IconLink size={12} />
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

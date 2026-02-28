"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SourceIcon, sourceColor, IconLink } from "@/components/icons";
import type { WorkItem, Project } from "@/lib/types";
import "./issues-tab.css";

interface IssuesTabProps {
  items: WorkItem[];
  hasDataSource: boolean;
  project: Project;
}

export function IssuesTab({ items, hasDataSource, project }: IssuesTabProps) {
  const [enabledSources, setEnabledSources] = useState<string[]>(
    project.dataSources || (project.githubRepo ? ["github"] : [])
  );

  const filtered = items.filter((item) => enabledSources.includes(item.source));

  return (
    <div>
      {/* Filter row */}
      <div className="issues-tab__filter-row">
        <span className="issues-tab__filter-label">Filter</span>
        {["github", "jira", "notion"].map((s) => (
          <label key={s} className="issues-tab__filter-source">
            <input
              type="checkbox"
              checked={enabledSources.includes(s)}
              onChange={() =>
                setEnabledSources((prev) =>
                  prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                )
              }
              className="issues-tab__filter-checkbox"
            />
            <span
              className="issues-tab__filter-source-text"
              style={{
                color: enabledSources.includes(s) ? sourceColor(s) : "#555",
                opacity: enabledSources.includes(s) ? 1 : 0.5,
              }}
            >
              <SourceIcon source={s} size={12} />
              <span>{s}</span>
            </span>
          </label>
        ))}
        <span className="issues-tab__filter-count">
          {filtered.length} item{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="issues-tab__empty">
          {hasDataSource
            ? "No open items from enabled sources."
            : "Connect a data source like GitHub, Notion, or Jira to pull in issues and tasks."}
        </div>
      ) : (
        <div className="issues-tab__list">
          {filtered.slice(0, 15).map((item) => (
            <a
              key={`${item.source}-${item.id}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="issues-tab__item"
            >
              <span style={{ color: sourceColor(item.source) }}>
                <SourceIcon source={item.source} size={14} />
              </span>
              <span className="issues-tab__item-title">{item.title}</span>
              <span className="issues-tab__item-id">{item.id}</span>
              {item.labels?.slice(0, 3).map((l) => (
                <Badge key={l} color="#666" small>{l}</Badge>
              ))}
              <span className="issues-tab__item-link">
                <IconLink size={12} />
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

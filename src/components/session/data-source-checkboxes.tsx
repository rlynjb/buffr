"use client";

import { useState, useEffect } from "react";
import { listIntegrations, updateProject } from "@/lib/api";
import { SourceIcon, sourceColor } from "@/components/icons";
import type { Project } from "@/lib/types";
import "./data-source-checkboxes.css";

interface DataSourceCheckboxesProps {
  project: Project;
  onUpdate: (updated: Project) => void;
}

export function DataSourceCheckboxes({ project, onUpdate }: DataSourceCheckboxesProps) {
  const [connectedSources, setConnectedSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const enabled = project.dataSources || [];

  useEffect(() => {
    listIntegrations()
      .then((integrations) => {
        const connected = integrations
          .filter((i) => i.status === "connected")
          .map((i) => i.id);
        setConnectedSources(connected);
      })
      .catch(() => setConnectedSources([]));
  }, []);

  if (connectedSources.length === 0) return null;

  async function toggle(sourceId: string) {
    setSaving(true);
    const next = enabled.includes(sourceId)
      ? enabled.filter((s) => s !== sourceId)
      : [...enabled, sourceId];
    try {
      const updated = await updateProject(project.id, { dataSources: next });
      onUpdate(updated);
    } catch (err) {
      console.error("Failed to update data sources:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="data-source-checkboxes">
      <span className="data-source-checkboxes__label">Filter</span>
      {connectedSources.map((source) => (
        <label key={source} className="data-source-checkboxes__option">
          <input
            type="checkbox"
            checked={enabled.includes(source)}
            onChange={() => toggle(source)}
            disabled={saving}
            className="data-source-checkboxes__checkbox"
          />
          <span
            className="data-source-checkboxes__source"
            style={{
              color: enabled.includes(source) ? sourceColor(source) : "#555",
              opacity: enabled.includes(source) ? 1 : 0.5,
            }}
          >
            <SourceIcon source={source} size={12} />
            <span>{source}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

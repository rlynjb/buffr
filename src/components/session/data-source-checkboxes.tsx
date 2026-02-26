"use client";

import { useState, useEffect } from "react";
import { listIntegrations, updateProject } from "@/lib/api";
import type { Project } from "@/lib/types";

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
    <div className="flex gap-3 items-center">
      <span className="text-xs text-muted">Sources:</span>
      {connectedSources.map((source) => (
        <label key={source} className="flex items-center gap-1 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={enabled.includes(source)}
            onChange={() => toggle(source)}
            disabled={saving}
            className="accent-accent"
          />
          {source}
        </label>
      ))}
    </div>
  );
}

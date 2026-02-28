"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconBack, IconSearch, SourceIcon, sourceColor } from "@/components/icons";
import type { ToolIntegration } from "@/lib/types";
import { listIntegrations, removeIntegration, getDefaultDataSources, setDefaultDataSources } from "@/lib/api";
import { ConfigModal } from "@/components/tools/config-modal";
import { TestToolModal } from "@/components/tools/test-tool-modal";
import "./page.css";

export default function ToolsPage() {
  const [integrations, setIntegrations] = useState<ToolIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultSources, setDefaultSourcesState] = useState<string[]>(["github"]);
  const [savingDefaults, setSavingDefaults] = useState(false);

  const [configOpen, setConfigOpen] = useState(false);
  const [configIntegration, setConfigIntegration] = useState<ToolIntegration | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testTool, setTestTool] = useState<string | null>(null);

  const [toolQuery, setToolQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<string>("all");

  useEffect(() => {
    load();
    getDefaultDataSources().then(setDefaultSourcesState).catch(() => setDefaultSourcesState(["github"]));
  }, []);

  async function load() {
    try {
      const data = await listIntegrations();
      setIntegrations(data);
    } catch (err) {
      console.error("Failed to load integrations:", err);
    } finally {
      setLoading(false);
    }
  }

  function openConfig(integration: ToolIntegration) {
    setConfigIntegration(integration);
    setConfigOpen(true);
  }

  function openTest(toolName: string) {
    setTestTool(toolName);
    setTestOpen(true);
  }

  async function handleDelete(integrationId: string, name: string) {
    if (!confirm(`Remove "${name}" integration config?`)) return;
    try {
      await removeIntegration(integrationId);
      await load();
    } catch (err) {
      console.error("Failed to delete integration:", err);
    }
  }

  async function toggleDefaultSource(sourceId: string) {
    setSavingDefaults(true);
    const next = defaultSources.includes(sourceId)
      ? defaultSources.filter((s) => s !== sourceId)
      : [...defaultSources, sourceId];
    try {
      await setDefaultDataSources(next);
      setDefaultSourcesState(next);
    } catch (err) {
      console.error("Failed to save default sources:", err);
    } finally {
      setSavingDefaults(false);
    }
  }

  const allTools = integrations.flatMap((i) =>
    i.tools.map((t) => ({
      ...t,
      integrationId: i.id,
      integrationName: i.name,
    }))
  );

  const filteredTools = allTools.filter((t) => {
    const matchesQuery = !toolQuery ||
      t.name.toLowerCase().includes(toolQuery.toLowerCase()) ||
      t.description.toLowerCase().includes(toolQuery.toLowerCase());
    const matchesFilter = toolFilter === "all" || t.integrationId === toolFilter;
    return matchesQuery && matchesFilter;
  });

  const connectedIds = integrations.filter((i) => i.status === "connected").map((i) => i.id);

  return (
    <div>
      <Link href="/" className="tools-page__back">
        <IconBack size={14} /> Dashboard
      </Link>

      <h1 className="tools-page__title">Tools & Integrations</h1>

      {/* Default Data Sources */}
      <div className="tools-page__defaults">
        <div className="tools-page__defaults-label">
          Default Data Sources for New Projects
        </div>
        <div className="tools-page__defaults-row">
          {["github", "notion", "jira"].map((s) => {
            const isConnected = connectedIds.includes(s);
            return (
              <label key={s} className="tools-page__defaults-option">
                <input
                  type="checkbox"
                  checked={defaultSources.includes(s)}
                  onChange={() => toggleDefaultSource(s)}
                  disabled={savingDefaults || !isConnected}
                  className="tools-page__defaults-checkbox"
                />
                <span
                  className="tools-page__defaults-source"
                  style={{ color: isConnected ? sourceColor(s) : "#555" }}
                >
                  <SourceIcon source={s} size={14} />
                  <span className="capitalize">{s}</span>
                </span>
                {!isConnected && <span className="tools-page__defaults-note">(not configured)</span>}
              </label>
            );
          })}
        </div>
      </div>

      {/* Integrations */}
      <div className="tools-page__section-label mb-3">
        Integrations
      </div>

      {loading ? (
        <div className="space-y-3 mb-8">
          {[1, 2, 3].map((i) => (
            <div key={i} className="tools-page__skeleton" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 mb-8">
          {integrations.map((integration) => (
            <div key={integration.id} className="tools-page__integration">
              <span
                className="tools-page__integration-icon"
                style={{ color: sourceColor(integration.id) }}
              >
                <SourceIcon source={integration.id} size={18} />
              </span>
              <div className="tools-page__integration-body">
                <div className="tools-page__integration-header">
                  <span className="tools-page__integration-name">{integration.name}</span>
                  <Badge
                    color={integration.status === "connected" ? "#34d399" : integration.status === "error" ? "#fbbf24" : "#71717a"}
                    small
                  >
                    {integration.status === "connected" ? "Connected" : integration.status === "error" ? "Error" : "Not Configured"}
                  </Badge>
                  <span className="tools-page__integration-tool-count">
                    {integration.tools.length} tool{integration.tools.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="tools-page__integration-desc">{integration.description}</div>
              </div>
              <div className="tools-page__integration-actions">
                {integration.configFields.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => openConfig(integration)}>
                    Configure
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => openTest(integration.tools[0]?.name || integration.id)}>
                  Test
                </Button>
                {!["github", "notion", "jira"].includes(integration.id) && (
                  <button
                    onClick={() => handleDelete(integration.id, integration.name)}
                    className="tools-page__integration-remove"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tool Registry */}
      <div className="tools-page__registry-header">
        <div className="tools-page__section-label">
          Tool Registry ({filteredTools.length})
        </div>
        <div className="flex items-center gap-2">
          <div className="tools-page__registry-search">
            <span className="tools-page__registry-search-icon">
              <IconSearch size={12} />
            </span>
            <input
              value={toolQuery}
              onChange={(e) => setToolQuery(e.target.value)}
              placeholder="Search tools..."
              className="tools-page__registry-search-input"
            />
          </div>
          <div className="tools-page__registry-filter">
            {["all", ...integrations.map((i) => i.id)].map((f) => (
              <button
                key={f}
                onClick={() => setToolFilter(f)}
                className={`tools-page__registry-filter-btn ${
                  toolFilter === f
                    ? "tools-page__registry-filter-btn--active"
                    : "tools-page__registry-filter-btn--inactive"
                }`}
              >
                {f === "all" ? (
                  "All"
                ) : (
                  <span className="flex items-center gap-1" style={{ color: sourceColor(f) }}>
                    <SourceIcon source={f} size={10} />
                    <span className="capitalize">{f}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="tools-page__registry">
        <div className="tools-page__registry-head">
          <span>Tool</span>
          <span>Parameters</span>
          <span>Source</span>
        </div>
        <div className="divide-y divide-zinc-800/30">
          {filteredTools.map((tool) => (
            <div key={tool.name} className="tools-page__registry-row">
              <div>
                <span className="tools-page__registry-tool-name">{tool.name}</span>
                <span className="tools-page__registry-tool-desc">{tool.description}</span>
              </div>
              <span className="tools-page__registry-tool-params">
                {tool.inputSchema
                  ? Object.keys((tool.inputSchema as Record<string, Record<string, unknown>>).properties || tool.inputSchema).slice(0, 4).join(", ") || "—"
                  : "—"}
              </span>
              <span style={{ color: sourceColor(tool.integrationId) }}>
                <SourceIcon source={tool.integrationId} size={14} />
              </span>
            </div>
          ))}
          {filteredTools.length === 0 && (
            <div className="tools-page__registry-empty">
              No tools match your search.
            </div>
          )}
        </div>
      </div>

      <ConfigModal
        integration={configIntegration}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => { setConfigOpen(false); load(); }}
      />

      <TestToolModal
        toolName={testTool}
        open={testOpen}
        onClose={() => setTestOpen(false)}
      />
    </div>
  );
}

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
      <Link
        href="/"
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-6 transition-colors"
      >
        <IconBack size={14} /> Dashboard
      </Link>

      <h1 className="text-lg font-semibold text-zinc-100 mb-6">Tools & Integrations</h1>

      {/* Default Data Sources */}
      <div className="mb-6 p-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">
          Default Data Sources for New Projects
        </div>
        <div className="flex gap-3">
          {["github", "notion", "jira"].map((s) => {
            const isConnected = connectedIds.includes(s);
            return (
              <label key={s} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={defaultSources.includes(s)}
                  onChange={() => toggleDefaultSource(s)}
                  disabled={savingDefaults || !isConnected}
                  className="accent-purple-500 w-3.5 h-3.5"
                />
                <span
                  className="flex items-center gap-1 text-sm"
                  style={{ color: isConnected ? sourceColor(s) : "#555" }}
                >
                  <SourceIcon source={s} size={14} />
                  <span className="capitalize">{s}</span>
                </span>
                {!isConnected && <span className="text-[10px] text-zinc-600">(not configured)</span>}
              </label>
            );
          })}
        </div>
      </div>

      {/* Integrations */}
      <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-3">
        Integrations
      </div>

      {loading ? (
        <div className="space-y-3 mb-8">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-xl border border-zinc-800/60 bg-zinc-900/30 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 mb-8">
          {integrations.map((integration) => (
            <div
              key={integration.id}
              className="flex items-center gap-4 px-4 py-3.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700/60 transition-colors"
            >
              <span
                className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center"
                style={{ color: sourceColor(integration.id) }}
              >
                <SourceIcon source={integration.id} size={18} />
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-200">{integration.name}</span>
                  <Badge
                    color={integration.status === "connected" ? "#34d399" : integration.status === "error" ? "#fbbf24" : "#71717a"}
                    small
                  >
                    {integration.status === "connected" ? "Connected" : integration.status === "error" ? "Error" : "Not Configured"}
                  </Badge>
                  <span className="text-[10px] text-zinc-600">
                    {integration.tools.length} tool{integration.tools.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="text-xs text-zinc-500">{integration.description}</div>
              </div>
              <div className="flex gap-2">
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
                    className="text-xs text-red-400/60 hover:text-red-400 transition-colors cursor-pointer"
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
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
          Tool Registry ({filteredTools.length})
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
              <IconSearch size={12} />
            </span>
            <input
              value={toolQuery}
              onChange={(e) => setToolQuery(e.target.value)}
              placeholder="Search tools..."
              className="pl-8 pr-3 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 w-48 transition-colors"
            />
          </div>
          <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden">
            {["all", ...integrations.map((i) => i.id)].map((f) => (
              <button
                key={f}
                onClick={() => setToolFilter(f)}
                className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  toolFilter === f
                    ? "bg-zinc-700/50 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
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

      <div className="rounded-xl border border-zinc-800/60 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2 bg-zinc-900/50 border-b border-zinc-800/40 text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">
          <span>Tool</span>
          <span>Parameters</span>
          <span>Source</span>
        </div>
        <div className="divide-y divide-zinc-800/30">
          {filteredTools.map((tool) => (
            <div
              key={tool.name}
              className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-4 py-2.5 hover:bg-white/[0.015] transition-colors"
            >
              <div>
                <span className="text-sm text-zinc-200 font-mono">{tool.name}</span>
                <span className="text-xs text-zinc-500 ml-2">{tool.description}</span>
              </div>
              <span className="text-[11px] text-zinc-600 font-mono">
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
            <div className="px-4 py-6 text-center text-xs text-zinc-600">
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

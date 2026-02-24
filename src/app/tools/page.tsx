"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ToolIntegration } from "@/lib/types";
import { listIntegrations, removeIntegration } from "@/lib/api";
import { AddIntegrationModal } from "@/components/tools/add-integration-modal";
import { ConfigModal } from "@/components/tools/config-modal";
import { TestToolModal } from "@/components/tools/test-tool-modal";

const BUILTIN_IDS = new Set(["github", "notion"]);

const statusBadge: Record<string, "success" | "warning" | "default"> = {
  connected: "success",
  error: "warning",
  not_configured: "default",
};

const statusLabel: Record<string, string> = {
  connected: "Connected",
  error: "Config Error",
  not_configured: "Not Configured",
};

export default function ToolsPage() {
  const [integrations, setIntegrations] = useState<ToolIntegration[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [addOpen, setAddOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configIntegration, setConfigIntegration] =
    useState<ToolIntegration | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testTool, setTestTool] = useState<string | null>(null);

  useEffect(() => {
    load();
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
    if (!confirm(`Remove "${name}" integration? This will delete its config.`)) {
      return;
    }
    try {
      await removeIntegration(integrationId);
      await load();
    } catch (err) {
      console.error("Failed to delete integration:", err);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground font-mono">
            Tools & Integrations
          </h1>
          <p className="text-sm text-muted mt-1">
            Manage your connected tools. Each integration exposes MCP-compatible
            tools that can be used across your projects.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>Add Integration</Button>
      </div>

      {/* Integration Cards */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-36 rounded-xl border border-border bg-card animate-pulse"
            />
          ))}
        </div>
      ) : integrations.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted text-sm mb-4">
            No integrations yet. Add your first integration to get started.
          </p>
          <Button onClick={() => setAddOpen(true)}>
            Add First Integration
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-foreground">
                      {integration.name}
                    </h2>
                    {BUILTIN_IDS.has(integration.id) && (
                      <Badge variant="default">built-in</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted mt-0.5">
                    {integration.description}
                  </p>
                </div>
                <Badge variant={statusBadge[integration.status]}>
                  {statusLabel[integration.status]}
                </Badge>
              </div>

              {/* Tools list */}
              {integration.tools.length > 0 && (
                <div className="mb-3">
                  <span className="text-xs text-muted block mb-1.5">
                    Available tools ({integration.tools.length})
                  </span>
                  <div className="space-y-1.5">
                    {integration.tools.map((tool) => (
                      <div
                        key={tool.name}
                        className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2"
                      >
                        <div>
                          <span className="text-sm font-mono text-foreground">
                            {tool.name}
                          </span>
                          <span className="text-xs text-muted ml-2">
                            {tool.description}
                          </span>
                        </div>
                        {integration.status === "connected" && (
                          <button
                            onClick={() => openTest(tool.name)}
                            className="text-xs text-accent hover:underline shrink-0 ml-3"
                          >
                            Test
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3">
                {integration.configFields.length > 0 && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => openConfig(integration)}
                    >
                      Configure
                    </Button>
                    <span className="text-xs text-muted">
                      Requires:{" "}
                      {integration.configFields
                        .map((f) => f.label)
                        .join(", ")}
                    </span>
                  </>
                )}
                {!BUILTIN_IDS.has(integration.id) && (
                  <button
                    onClick={() =>
                      handleDelete(integration.id, integration.name)
                    }
                    className="text-xs text-error hover:underline ml-auto"
                  >
                    Remove
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <AddIntegrationModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          load();
        }}
      />

      <ConfigModal
        integration={configIntegration}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => {
          setConfigOpen(false);
          load();
        }}
      />

      <TestToolModal
        toolName={testTool}
        open={testOpen}
        onClose={() => setTestOpen(false)}
      />
    </div>
  );
}

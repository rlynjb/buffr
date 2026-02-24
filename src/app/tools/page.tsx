"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import type { ToolIntegration } from "@/lib/types";
import {
  listIntegrations,
  saveIntegrationConfig,
  executeToolAction,
  createIntegration,
  removeIntegration,
} from "@/lib/api";

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

interface ConfigField {
  key: string;
  label: string;
  secret: boolean;
}

export default function ToolsPage() {
  const [integrations, setIntegrations] = useState<ToolIntegration[]>([]);
  const [loading, setLoading] = useState(true);

  // Config modal
  const [configOpen, setConfigOpen] = useState(false);
  const [configIntegration, setConfigIntegration] =
    useState<ToolIntegration | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configEnabled, setConfigEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  // Test modal
  const [testOpen, setTestOpen] = useState(false);
  const [testTool, setTestTool] = useState<string | null>(null);
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Add integration modal
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [addFields, setAddFields] = useState<ConfigField[]>([
    { key: "", label: "", secret: false },
  ]);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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
    const values: Record<string, string> = {};
    for (const field of integration.configFields) {
      values[field.key] = "";
    }
    setConfigValues(values);
    setConfigEnabled(integration.status === "connected");
    setConfigOpen(true);
  }

  async function handleSaveConfig() {
    if (!configIntegration) return;
    setSaving(true);
    try {
      await saveIntegrationConfig(
        configIntegration.id,
        configValues,
        configEnabled
      );
      await load();
      setConfigOpen(false);
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  }

  function openTest(toolName: string) {
    setTestTool(toolName);
    setTestInput("{}");
    setTestResult(null);
    setTestOpen(true);
  }

  async function handleTest() {
    if (!testTool) return;
    setTesting(true);
    setTestResult(null);
    try {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(testInput);
      } catch {
        setTestResult("Error: Invalid JSON input");
        setTesting(false);
        return;
      }
      const result = await executeToolAction(testTool, input);
      setTestResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setTestResult(
        `Error: ${err instanceof Error ? err.message : "Execution failed"}`
      );
    } finally {
      setTesting(false);
    }
  }

  // Add integration
  function openAdd() {
    setAddName("");
    setAddDesc("");
    setAddFields([{ key: "", label: "", secret: false }]);
    setAddError(null);
    setAddOpen(true);
  }

  function updateField(index: number, updates: Partial<ConfigField>) {
    setAddFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...updates } : f))
    );
  }

  function addFieldRow() {
    setAddFields((prev) => [...prev, { key: "", label: "", secret: false }]);
  }

  function removeFieldRow(index: number) {
    setAddFields((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleAddSave() {
    if (!addName.trim()) return;
    setAddSaving(true);
    setAddError(null);
    try {
      // Filter out empty config fields, auto-generate key from label
      const fields = addFields
        .filter((f) => f.label.trim())
        .map((f) => ({
          key:
            f.key.trim() ||
            f.label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_|_$/g, ""),
          label: f.label.trim(),
          secret: f.secret,
        }));

      await createIntegration({
        name: addName.trim(),
        description: addDesc.trim(),
        configFields: fields,
      });
      await load();
      setAddOpen(false);
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : "Failed to create integration"
      );
    } finally {
      setAddSaving(false);
    }
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
        <Button onClick={openAdd}>Add Integration</Button>
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
          <Button onClick={openAdd}>Add First Integration</Button>
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

      {/* Add Integration Modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Integration"
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="e.g. Linear, Slack, Custom API"
          />
          <Input
            label="Description"
            value={addDesc}
            onChange={(e) => setAddDesc(e.target.value)}
            placeholder="What does this integration do?"
          />

          {/* Dynamic config fields */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Config Fields
            </label>
            <p className="text-xs text-muted mb-2">
              Define what credentials or settings this integration needs.
            </p>
            <div className="space-y-2">
              {addFields.map((field, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={field.label}
                    onChange={(e) =>
                      updateField(i, { label: e.target.value })
                    }
                    placeholder="Field label (e.g. API Token)"
                    className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap cursor-pointer">
                    <input
                      type="checkbox"
                      checked={field.secret}
                      onChange={(e) =>
                        updateField(i, { secret: e.target.checked })
                      }
                      className="accent-accent"
                    />
                    Secret
                  </label>
                  {addFields.length > 1 && (
                    <button
                      onClick={() => removeFieldRow(i)}
                      className="text-xs text-error hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={addFieldRow}
              className="mt-2 text-xs text-accent hover:underline"
            >
              + Add field
            </button>
          </div>

          {addError && (
            <p className="text-sm text-error">{addError}</p>
          )}

          <div className="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddSave}
              disabled={!addName.trim() || addSaving}
            >
              {addSaving ? "Creating..." : "Add Integration"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Config Modal */}
      <Modal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title={`Configure ${configIntegration?.name || ""}`}
      >
        <div className="space-y-4">
          {configIntegration?.configFields.map((field) => (
            <Input
              key={field.key}
              label={field.label}
              type={field.secret ? "password" : "text"}
              value={configValues[field.key] || ""}
              onChange={(e) =>
                setConfigValues((prev) => ({
                  ...prev,
                  [field.key]: e.target.value,
                }))
              }
              placeholder={
                field.secret
                  ? "••••••••"
                  : `Enter ${field.label.toLowerCase()}`
              }
            />
          ))}
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={configEnabled}
              onChange={(e) => setConfigEnabled(e.target.checked)}
              className="accent-accent"
            />
            Enabled
          </label>
          {configIntegration?.id === "github" && (
            <p className="text-xs text-muted">
              Note: GitHub also uses the{" "}
              <code className="font-mono">GITHUB_TOKEN</code> environment
              variable. If set on Netlify, GitHub tools work without
              configuring a token here.
            </p>
          )}
          <div className="flex gap-3 justify-end">
            <Button
              variant="secondary"
              onClick={() => setConfigOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveConfig} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Test Tool Modal */}
      <Modal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title={`Test: ${testTool || ""}`}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Input (JSON)
            </label>
            <textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              placeholder='{"ownerRepo": "user/repo"}'
            />
          </div>
          <Button onClick={handleTest} disabled={testing}>
            {testing ? "Running..." : "Execute"}
          </Button>
          {testResult && (
            <pre className="rounded-lg border border-border bg-background p-3 text-xs font-mono text-foreground whitespace-pre-wrap max-h-64 overflow-y-auto">
              {testResult}
            </pre>
          )}
        </div>
      </Modal>
    </div>
  );
}

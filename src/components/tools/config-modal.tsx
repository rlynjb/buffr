"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveIntegrationConfig } from "@/lib/api";
import type { ToolIntegration } from "@/lib/types";

interface ConfigModalProps {
  integration: ToolIntegration | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function ConfigModal({
  integration,
  open,
  onClose,
  onSaved,
}: ConfigModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!integration || !open) return;
    const v: Record<string, string> = {};
    for (const field of integration.configFields) {
      v[field.key] = "";
    }
    setValues(v);
    setEnabled(integration.status === "connected");
  }, [integration, open]);

  async function handleSave() {
    if (!integration) return;
    setSaving(true);
    try {
      await saveIntegrationConfig(integration.id, values, enabled);
      onSaved();
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Configure ${integration?.name || ""}`}
    >
      <div className="space-y-4">
        {integration?.configFields.map((field) => (
          <Input
            key={field.key}
            label={field.label}
            type={field.secret ? "password" : "text"}
            value={values[field.key] || ""}
            onChange={(e) =>
              setValues((prev) => ({
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
        <label className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-purple-500 w-3.5 h-3.5"
          />
          Enabled
        </label>
        {integration?.id === "github" && (
          <p className="text-xs text-zinc-500">
            Note: GitHub also uses the{" "}
            <code className="font-mono text-zinc-400">GITHUB_TOKEN</code> environment
            variable. If set on Netlify, GitHub tools work without configuring
            a token here.
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

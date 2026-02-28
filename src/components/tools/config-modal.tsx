"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveIntegrationConfig } from "@/lib/api";
import type { ToolIntegration } from "@/lib/types";
import "./config-modal.css";

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
      <div className="config-modal__body">
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
        <label className="config-modal__enabled">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="config-modal__enabled-checkbox"
          />
          Enabled
        </label>
        {integration?.id === "github" && (
          <p className="config-modal__note">
            Note: GitHub also uses the{" "}
            <code className="config-modal__note-code">GITHUB_TOKEN</code> environment
            variable. If set on Netlify, GitHub tools work without configuring
            a token here.
          </p>
        )}
        <div className="config-modal__footer">
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

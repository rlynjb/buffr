"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createIntegration } from "@/lib/api";

interface ConfigField {
  key: string;
  label: string;
  secret: boolean;
}

interface AddIntegrationModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddIntegrationModal({
  open,
  onClose,
  onCreated,
}: AddIntegrationModalProps) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [fields, setFields] = useState<ConfigField[]>([
    { key: "", label: "", secret: false },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setDesc("");
    setFields([{ key: "", label: "", secret: false }]);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function updateField(index: number, updates: Partial<ConfigField>) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...updates } : f))
    );
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const configFields = fields
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
        name: name.trim(),
        description: desc.trim(),
        configFields,
      });
      reset();
      onCreated();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create integration"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add Integration">
      <div className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Linear, Slack, Custom API"
        />
        <Input
          label="Description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What does this integration do?"
        />

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Config Fields
          </label>
          <p className="text-xs text-muted mb-2">
            Define what credentials or settings this integration needs.
          </p>
          <div className="space-y-2">
            {fields.map((field, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}
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
                {fields.length > 1 && (
                  <button
                    onClick={() =>
                      setFields((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="text-xs text-error hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() =>
              setFields((prev) => [
                ...prev,
                { key: "", label: "", secret: false },
              ])
            }
            className="mt-2 text-xs text-accent hover:underline"
          >
            + Add field
          </button>
        </div>

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex gap-3 justify-end">
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? "Creating..." : "Add Integration"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/textarea";
import { IconLoader, IconSparkle, IconCheck } from "@/components/icons";
import { buildSpec } from "@/lib/api";
import { useProvider } from "@/context/provider-context";
import type { BuffrSpecCategory } from "@/lib/types";

const SPEC_TYPES: Array<{ key: BuffrSpecCategory; label: string }> = [
  { key: "features", label: "Feature" },
  { key: "bugs", label: "Bug" },
  { key: "tests", label: "Test" },
  { key: "phases", label: "Phase" },
  { key: "migrations", label: "Migration" },
  { key: "refactors", label: "Refactor" },
  { key: "prompts", label: "Prompt" },
  { key: "performance", label: "Performance" },
  { key: "integrations", label: "Integration" },
];

interface SpecBuilderModalProps {
  open: boolean;
  onClose: () => void;
  actionText: string;
  projectId: string;
  onSpecCreated: (specPath: string) => void;
}

type Step = "type" | "generating" | "preview" | "saved";

export function SpecBuilderModal({
  open,
  onClose,
  actionText,
  projectId,
  onSpecCreated,
}: SpecBuilderModalProps) {
  const { selected } = useProvider();
  const [step, setStep] = useState<Step>("type");
  const [specType, setSpecType] = useState<BuffrSpecCategory>("features");
  const [specContent, setSpecContent] = useState("");
  const [specPath, setSpecPath] = useState("");
  const [gaps, setGaps] = useState<string[]>([]);
  const [error, setError] = useState("");

  function handleClose() {
    setStep("type");
    setSpecContent("");
    setSpecPath("");
    setGaps([]);
    setError("");
    onClose();
  }

  async function handleGenerate() {
    setStep("generating");
    setError("");
    try {
      const result = await buildSpec(actionText, projectId, undefined, selected);
      setSpecContent(result.spec);
      setSpecPath(result.path);
      setGaps(result.gaps);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate spec");
      setStep("type");
    }
  }

  function handleSave() {
    setStep("saved");
    onSpecCreated(specPath);
    setTimeout(handleClose, 1500);
  }

  // Auto-detect type from action text
  function detectType() {
    const lower = actionText.toLowerCase();
    const keywords: Record<BuffrSpecCategory, string[]> = {
      features: ["add", "implement", "build", "create", "new"],
      bugs: ["bug", "fix", "broken", "error", "crash"],
      tests: ["test", "testing", "coverage"],
      phases: ["phase", "milestone", "roadmap"],
      migrations: ["migrate", "migration", "upgrade"],
      refactors: ["refactor", "restructure", "cleanup"],
      prompts: ["prompt", "template", "ai"],
      performance: ["performance", "optimize", "speed", "slow"],
      integrations: ["integrate", "api", "connect"],
    };
    for (const [cat, kws] of Object.entries(keywords)) {
      if (kws.some((kw) => lower.includes(kw))) {
        return cat as BuffrSpecCategory;
      }
    }
    return "features" as BuffrSpecCategory;
  }

  if (!open) return null;

  return (
    <Modal open={open} onClose={handleClose} title="Generate Spec" size="wide">
      {step === "type" && (
        <div className="doc-tab__modal-form">
          <p style={{ color: "#a1a1aa", fontSize: "13px", marginBottom: "12px" }}>
            Creating spec from: <strong style={{ color: "#e4e4e7" }}>{actionText}</strong>
          </p>

          <div>
            <label className="doc-tab__modal-label">Spec Type</label>
            <div className="doc-tab__modal-categories">
              {SPEC_TYPES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setSpecType(t.key)}
                  className={`doc-tab__modal-cat ${specType === t.key ? "doc-tab__modal-cat--active" : "doc-tab__modal-cat--inactive"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p style={{ color: "#ef4444", fontSize: "12px" }}>{error}</p>
          )}

          <div className="doc-tab__modal-footer">
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button onClick={handleGenerate}>
              <IconSparkle size={14} /> Generate
            </Button>
          </div>
        </div>
      )}

      {step === "generating" && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#a1a1aa" }}>
          <IconLoader size={20} />
          <p style={{ marginTop: "12px", fontSize: "13px" }}>
            Generating spec from project context...
          </p>
        </div>
      )}

      {step === "preview" && (
        <div className="doc-tab__modal-form">
          <p style={{ color: "#71717a", fontSize: "11px", marginBottom: "4px" }}>
            {specPath}
          </p>

          {gaps.length > 0 && (
            <p style={{ color: "#fbbf24", fontSize: "12px", marginBottom: "8px" }}>
              Missing sections: {gaps.join(", ")}
            </p>
          )}

          <TextArea
            value={specContent}
            onChange={(e) => setSpecContent(e.target.value)}
            rows={16}
            mono
          />

          <div className="doc-tab__modal-footer">
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button variant="ghost" onClick={() => setStep("type")}>Back</Button>
            <Button onClick={handleSave}>
              <IconCheck size={14} /> Save Spec
            </Button>
          </div>
        </div>
      )}

      {step === "saved" && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#34d399" }}>
          <IconCheck size={20} />
          <p style={{ marginTop: "12px", fontSize: "13px" }}>
            Spec saved to {specPath}
          </p>
        </div>
      )}
    </Modal>
  );
}

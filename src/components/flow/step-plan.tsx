"use client";

import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import type { ProjectPlan, PlanFeature } from "@/lib/types";
import { AVAILABLE_PROJECT_FILES, DEFAULT_STACK } from "@/lib/types";

interface StepPlanProps {
  plan: ProjectPlan;
  selectedFiles: string[];
  regenerateCount: number;
  onUpdatePlan: (field: keyof ProjectPlan, value: unknown) => void;
  onUpdateFeature: (index: number, updates: Partial<PlanFeature>) => void;
  onMoveFeature: (index: number, toPhase: 1 | 2) => void;
  onToggleFile: (file: string) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onBack: () => void;
  regenerating: boolean;
}

const complexityBadge: Record<string, "default" | "warning" | "error"> = {
  simple: "default",
  medium: "warning",
  complex: "error",
};

export function StepPlan({
  plan,
  selectedFiles,
  regenerateCount,
  onUpdatePlan,
  onUpdateFeature,
  onMoveFeature,
  onToggleFile,
  onRegenerate,
  onContinue,
  onBack,
  regenerating,
}: StepPlanProps) {
  const indexed = plan.features.map((f, i) => ({ ...f, idx: i }));
  const phase1 = indexed.filter((f) => f.phase === 1);
  const phase2 = indexed.filter((f) => f.phase === 2);

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">
          Review Your Plan
        </h1>
        <p className="text-sm text-muted">
          Everything is editable. Tweak the plan, then continue.
        </p>
      </div>

      {/* Project Name */}
      <Input
        label="Project Name"
        value={plan.projectName}
        onChange={(e) => onUpdatePlan("projectName", e.target.value)}
      />

      {/* Project Description */}
      <TextArea
        label="Project Description"
        value={plan.description}
        onChange={(e) => onUpdatePlan("description", e.target.value)}
        rows={2}
      />

      {/* Tech Stack */}
      <div className="space-y-2">
        <TextArea
          label="Recommended Stack"
          value={plan.recommendedStack}
          onChange={(e) => onUpdatePlan("recommendedStack", e.target.value)}
          rows={2}
        />
        {plan.recommendedStack !== DEFAULT_STACK && (
          <button
            onClick={() => onUpdatePlan("recommendedStack", DEFAULT_STACK)}
            className="text-xs text-accent hover:underline cursor-pointer"
          >
            Or use your default: {DEFAULT_STACK}
          </button>
        )}
      </div>

      {/* Phase 1 Features */}
      <Card>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Phase 1 &mdash; MVP
        </h3>
        <div className="space-y-1">
          {phase1.map((feature) => (
            <div key={feature.idx} className="flex items-start gap-2">
              <div className="flex-1">
                <Checkbox
                  checked={feature.checked}
                  onChange={(checked) =>
                    onUpdateFeature(feature.idx, { checked })
                  }
                  label={feature.name}
                  description={feature.description}
                />
              </div>
              <Badge variant={complexityBadge[feature.complexity]}>
                {feature.complexity}
              </Badge>
              <button
                onClick={() => onMoveFeature(feature.idx, 2)}
                className="text-xs text-muted hover:text-foreground mt-1 shrink-0"
                title="Move to Phase 2"
              >
                &#8594; P2
              </button>
            </div>
          ))}
          {phase1.length === 0 && (
            <p className="text-xs text-muted">No Phase 1 features</p>
          )}
        </div>
      </Card>

      {/* Phase 2 Features */}
      <Card>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Phase 2 &mdash; Enhancements
        </h3>
        <div className="space-y-1">
          {phase2.map((feature) => (
            <div key={feature.idx} className="flex items-start gap-2">
              <div className="flex-1">
                <Checkbox
                  checked={feature.checked}
                  onChange={(checked) =>
                    onUpdateFeature(feature.idx, { checked })
                  }
                  label={feature.name}
                  description={feature.description}
                />
              </div>
              <Badge variant={complexityBadge[feature.complexity]}>
                {feature.complexity}
              </Badge>
              <button
                onClick={() => onMoveFeature(feature.idx, 1)}
                className="text-xs text-muted hover:text-foreground mt-1 shrink-0"
                title="Move to Phase 1"
              >
                &#8592; P1
              </button>
            </div>
          ))}
          {phase2.length === 0 && (
            <p className="text-xs text-muted">No Phase 2 features</p>
          )}
        </div>
      </Card>

      {/* Deploy Checklist */}
      <Card>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Deploy Checklist
        </h3>
        <ol className="list-decimal list-inside space-y-1 text-sm text-muted">
          {plan.deployChecklist.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      </Card>

      {/* Project Files */}
      <Card>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Project Files
        </h3>
        <div className="space-y-0.5">
          {AVAILABLE_PROJECT_FILES.map((file) => (
            <Checkbox
              key={file}
              checked={selectedFiles.includes(file)}
              onChange={() => onToggleFile(file)}
              label={file}
            />
          ))}
        </div>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {regenerateCount < 3 && (
          <Button
            variant="secondary"
            onClick={onRegenerate}
            loading={regenerating}
          >
            Regenerate Plan ({3 - regenerateCount} left)
          </Button>
        )}
        <Button onClick={onContinue}>
          Continue to Repo Setup
        </Button>
      </div>
    </div>
  );
}

"use client";

import type { FlowStep } from "@/lib/flow-state";

const steps: Array<{ num: FlowStep; label: string }> = [
  { num: 1, label: "Project Info" },
  { num: 2, label: "Plan" },
  { num: 3, label: "Repo Setup" },
  { num: 4, label: "Deploy" },
];

interface StepIndicatorProps {
  current: FlowStep;
}

export function StepIndicator({ current }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.num} className="flex items-center">
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-mono transition-colors ${
              s.num === current
                ? "bg-accent text-white"
                : s.num < current
                  ? "bg-success/10 text-success"
                  : "bg-card text-muted border border-border"
            }`}
          >
            <span>{s.num}</span>
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`mx-2 h-px w-6 ${
                s.num < current ? "bg-success" : "bg-border"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

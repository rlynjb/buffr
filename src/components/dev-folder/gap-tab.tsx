"use client";

import type { GapAnalysisEntry } from "@/lib/types";
import "./gap-tab.css";

interface GapTabProps {
  gapAnalysis: GapAnalysisEntry[];
}

const statusEmoji: Record<GapAnalysisEntry["status"], string> = {
  aligned: "\u{1F7E2}",
  partial: "\u{1F7E1}",
  gap: "\u{1F534}",
};

const projectClass: Record<GapAnalysisEntry["status"], string> = {
  aligned: "gap-tab__project--aligned",
  partial: "gap-tab__project--partial",
  gap: "gap-tab__project--gap",
};

export function GapTab({ gapAnalysis }: GapTabProps) {
  const alignedCount = gapAnalysis.filter((e) => e.status === "aligned").length;
  const partialCount = gapAnalysis.filter((e) => e.status === "partial").length;
  const gapCount = gapAnalysis.filter((e) => e.status === "gap").length;

  return (
    <div className="gap-tab">
      <div className="gap-tab__table">
        <div className="gap-tab__header">
          <span>Practice</span>
          <span>Industry Standard</span>
          <span>This Project</span>
          <span>Gap</span>
        </div>

        {gapAnalysis.map((entry, index) => (
          <div
            key={index}
            className={[
              "gap-tab__row",
              entry.status === "gap" ? "gap-tab__row--gap" : "",
              index % 2 === 1 ? "gap-tab__row--alt" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="gap-tab__practice">{entry.practice}</span>
            <span className="gap-tab__industry">{entry.industry}</span>
            <span className={projectClass[entry.status]}>{entry.project}</span>
            <span className="gap-tab__status">
              {statusEmoji[entry.status]}
            </span>
          </div>
        ))}

        <div className="gap-tab__legend">
          <span>
            {"\u{1F7E2}"} Aligned ({alignedCount})
          </span>
          <span>
            {"\u{1F7E1}"} Partial ({partialCount})
          </span>
          <span>
            {"\u{1F534}"} Gap ({gapCount})
          </span>
        </div>
      </div>
    </div>
  );
}

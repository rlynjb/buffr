"use client";

import { IconFileTree } from "@/components/icons";
import type { GapAnalysisEntry } from "@/lib/types";
import "./gap-tab.css";

interface GapTabProps {
  gapAnalysis: GapAnalysisEntry[];
  onNavigateToFile?: (category: string) => void;
}

const statusLabel: Record<GapAnalysisEntry["status"], string> = {
  aligned: "Aligned",
  partial: "Partial",
  gap: "Gap",
};

const projectClass: Record<GapAnalysisEntry["status"], string> = {
  aligned: "gap-tab__project--aligned",
  partial: "gap-tab__project--partial",
  gap: "gap-tab__project--gap",
};

export function GapTab({ gapAnalysis, onNavigateToFile }: GapTabProps) {
  return (
    <div className="gap-tab">
      <p className="gap-tab__desc">
        Each row compares an industry best practice against what was detected in
        your project.{" "}
        <span className="gap-tab__desc-legend">
          <span className="gap-tab__desc-dot gap-tab__desc-dot--aligned" /> Aligned
          {" = "}meets the standard,{" "}
          <span className="gap-tab__desc-dot gap-tab__desc-dot--partial" /> Partial
          {" = "}partially in place,{" "}
          <span className="gap-tab__desc-dot gap-tab__desc-dot--gap" /> Gap
          {" = "}missing or not detected.
        </span>
      </p>

      <table className="gap-tab__table">
        <thead>
          <tr className="gap-tab__header">
            <th>Practice</th>
            <th>Industry Standard</th>
            <th>Your Project</th>
            <th>Status</th>
            <th className="gap-tab__header-action"></th>
          </tr>
        </thead>
        <tbody>
          {gapAnalysis.map((entry, index) => (
            <tr
              key={index}
              className={[
                "gap-tab__row",
                entry.status === "gap" ? "gap-tab__row--gap" : "",
                index % 2 === 1 ? "gap-tab__row--alt" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <td className="gap-tab__practice">{entry.practice}</td>
              <td className="gap-tab__industry">{entry.industry}</td>
              <td className={projectClass[entry.status]}>{entry.project}</td>
              <td>
                <span className={`gap-tab__badge gap-tab__badge--${entry.status}`}>
                  {statusLabel[entry.status]}
                </span>
              </td>
              <td className="gap-tab__action-cell">
                {onNavigateToFile && (
                  <button
                    className="gap-tab__view-file"
                    onClick={() => onNavigateToFile(entry.category)}
                    title="View related file"
                  >
                    <IconFileTree size={11} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

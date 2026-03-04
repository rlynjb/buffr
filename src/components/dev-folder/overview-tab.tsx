"use client";

import type { ScanResult, TechDebtItem } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { IconFileTree } from "@/components/icons";
import { timeAgo } from "@/lib/format";
import "./overview-tab.css";

interface OverviewTabProps {
  scanResult: ScanResult;
}

type Severity = TechDebtItem["severity"];

const severityRank: Record<Severity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function groupDebtByType(items: TechDebtItem[]) {
  const groups = new Map<
    string,
    { count: number; maxSeverity: Severity }
  >();

  for (const item of items) {
    const existing = groups.get(item.type);
    if (existing) {
      existing.count++;
      if (severityRank[item.severity] > severityRank[existing.maxSeverity]) {
        existing.maxSeverity = item.severity;
      }
    } else {
      groups.set(item.type, { count: 1, maxSeverity: item.severity });
    }
  }

  return groups;
}

export function OverviewTab({ scanResult }: OverviewTabProps) {
  const alignedCount = scanResult.gapAnalysis.filter(
    (e) => e.status === "aligned",
  ).length;
  const partialCount = scanResult.gapAnalysis.filter(
    (e) => e.status === "partial",
  ).length;
  const gapCount = scanResult.gapAnalysis.filter(
    (e) => e.status === "gap",
  ).length;

  const debtGroups = groupDebtByType(scanResult.techDebtItems);

  return (
    <div className="overview-tab">
      {/* Gap score cards */}
      <div className="overview-tab__score-grid">
        <div className="overview-tab__score-card overview-tab__score-card--aligned">
          <div className="overview-tab__score-value--aligned">
            {alignedCount}
          </div>
          <div className="overview-tab__score-label">Aligned</div>
        </div>
        <div className="overview-tab__score-card overview-tab__score-card--partial">
          <div className="overview-tab__score-value--partial">
            {partialCount}
          </div>
          <div className="overview-tab__score-label">Partial</div>
        </div>
        <div className="overview-tab__score-card overview-tab__score-card--gaps">
          <div className="overview-tab__score-value--gaps">{gapCount}</div>
          <div className="overview-tab__score-label">Gaps</div>
        </div>
      </div>

      {/* Detected stack */}
      <div className="overview-tab__card">
        <div className="overview-tab__heading">Detected Stack</div>
        <div className="overview-tab__stack-list">
          {scanResult.detectedStack.map((tech) => (
            <Badge key={tech} color="#34d399">
              {tech}
            </Badge>
          ))}
        </div>
      </div>

      {/* Tech debt inventory */}
      <div className="overview-tab__card">
        <div className="overview-tab__heading">Tech Debt Inventory</div>
        <div className="overview-tab__debt-list">
          {Array.from(debtGroups.entries()).map(
            ([type, { count, maxSeverity }]) => (
              <div key={type} className="overview-tab__debt-item">
                <span
                  className={`overview-tab__debt-dot overview-tab__debt-dot--${maxSeverity}`}
                />
                <span className="overview-tab__debt-type">{type}</span>
                <span className="overview-tab__debt-count">{count}</span>
              </div>
            ),
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="overview-tab__footer">
        <span>Last scanned: {timeAgo(scanResult.updatedAt)}</span>
        <span>
          {scanResult.generatedFiles.length} files generated
          {scanResult.analysisSource && (
            <> · Analysis: {scanResult.analysisSource === "llm" ? "LLM" : "rule-based"}</>
          )}
        </span>
      </div>
    </div>
  );
}

"use client";

import type { ScanResult } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import "./overview-tab.css";

interface OverviewTabProps {
  scanResult: ScanResult;
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

  return (
    <div className="overview-tab">
      {/* Gap analysis intro */}
      <div className="overview-tab__intro">
        <div className="overview-tab__heading">Gap Analysis</div>
        <p className="overview-tab__intro-desc">
          Compares your project against industry best practices across testing,
          security, performance, accessibility, CI/CD, and more.
        </p>
      </div>

      {/* Gap score cards */}
      <div className="overview-tab__score-grid">
        <div className="overview-tab__score-card overview-tab__score-card--aligned">
          <div className="overview-tab__score-value--aligned">
            {alignedCount}
          </div>
          <div className="overview-tab__score-label">Aligned</div>
          <div className="overview-tab__score-desc">Meets industry standard</div>
        </div>
        <div className="overview-tab__score-card overview-tab__score-card--partial">
          <div className="overview-tab__score-value--partial">
            {partialCount}
          </div>
          <div className="overview-tab__score-label">Partial</div>
          <div className="overview-tab__score-desc">Partially implemented</div>
        </div>
        <div className="overview-tab__score-card overview-tab__score-card--gaps">
          <div className="overview-tab__score-value--gaps">{gapCount}</div>
          <div className="overview-tab__score-label">Gaps</div>
          <div className="overview-tab__score-desc">Missing or not detected</div>
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

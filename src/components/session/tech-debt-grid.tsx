"use client";

import type { TechDebtSummaryEntry } from "@/lib/types";
import "./tech-debt-grid.css";

interface TechDebtGridProps {
  summary: TechDebtSummaryEntry[];
  scannedAt?: string;
}

export function TechDebtGrid({ summary, scannedAt }: TechDebtGridProps) {
  if (summary.length === 0) return null;

  return (
    <div className="tech-debt">
      <div className="tech-debt__header">
        <div className="tech-debt__header-left">
          <span className="tech-debt__icon">&#128737;</span>
          <span className="tech-debt__label">Tech Debt</span>
        </div>
      </div>
      <p className="tech-debt__desc">
        Scans source code for JSDoc-style comment annotations
        (<code>TODO</code>, <code>FIXME</code>, <code>HACK</code>)
        and checks for missing project infrastructure like tests, CI/CD, and linters.
      </p>
      <div className="tech-debt__grid">
        {summary.map((d) => (
          <div key={d.type} className="tech-debt__item">
            <span className={`tech-debt__dot tech-debt__dot--${d.severity}`} />
            <span className="tech-debt__type">{d.type}</span>
            <span className="tech-debt__count">{d.count}</span>
          </div>
        ))}
      </div>
      <div className="tech-debt__footer">
        <span className="tech-debt__legend">
          <span className="tech-debt__dot tech-debt__dot--high" /> High
        </span>
        <span className="tech-debt__legend">
          <span className="tech-debt__dot tech-debt__dot--medium" /> Medium
        </span>
        <span className="tech-debt__legend">
          <span className="tech-debt__dot tech-debt__dot--low" /> Low
        </span>
        {scannedAt && (
          <span className="tech-debt__scanned">
            Scanned {new Date(scannedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

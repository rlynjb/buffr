"use client";

import { useMemo } from "react";
import "./diff-view.css";

interface DiffViewProps {
  oldContent: string;
  newContent: string;
}

type DiffLine = { type: "same" | "add" | "remove"; text: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "same", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}

export function DiffView({ oldContent, newContent }: DiffViewProps) {
  const lines = useMemo(() => computeDiff(oldContent, newContent), [oldContent, newContent]);

  return (
    <div className="diff-view">
      {lines.map((line, i) => (
        <div key={i} className={`diff-view__line diff-view__line--${line.type}`}>
          <span className="diff-view__marker">
            {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
          </span>
          <span className="diff-view__text">{line.text || "\u00A0"}</span>
        </div>
      ))}
    </div>
  );
}

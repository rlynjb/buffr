"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { IconEye } from "@/components/icons";
import "./file-tree-tab.css";

interface FileTreeTabProps {
  generatedFiles: Array<{ path: string; content: string; ownership: string }>;
}

type Ownership = "system" | "reviewable" | "append-only" | "user";

const ownershipColors: Record<Ownership, string> = {
  system: "#60a5fa",
  reviewable: "#fbbf24",
  "append-only": "#a78bfa",
  user: "#34d399",
};

const ownershipLabels: Record<Ownership, string> = {
  system: "System-managed",
  reviewable: "Reviewable",
  "append-only": "Append-only",
  user: "User-owned",
};

const ownershipExplanations: Record<Ownership, string> = {
  system: "Regenerated on every re-scan",
  reviewable: "Changes proposed as diff \u2014 you review and approve",
  user: "Your file \u2014 never overwritten by buffr",
  "append-only": "buffr only adds new entries, never edits or removes",
};

function resolveOwnership(file: { path: string; ownership: string }): Ownership {
  const o = file.ownership as Ownership;
  if (o in ownershipColors) return o;
  return "system";
}

function getDirectory(path: string): string {
  // Strip .dev/ prefix and return the subdirectory (e.g., "context", "industry")
  const stripped = path.replace(/^\.dev\//, "");
  const segments = stripped.split("/");
  return segments.length > 1 ? segments[0] : "";
}

function getFilename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

export function FileTreeTab({ generatedFiles }: FileTreeTabProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const toggleFile = (path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  };

  let lastDirectory = "";

  return (
    <div className="file-tree-tab">
      {/* Ownership legend */}
      <div className="file-tree-tab__legend">
        {(Object.keys(ownershipColors) as Ownership[]).map((key) => (
          <div key={key} className="file-tree-tab__legend-item">
            <span
              className="file-tree-tab__legend-swatch"
              style={{ backgroundColor: ownershipColors[key] }}
            />
            <span className="file-tree-tab__legend-label">
              {ownershipLabels[key]}
            </span>
          </div>
        ))}
      </div>

      {/* File list */}
      <div className="file-tree-tab__list">
        {generatedFiles.map((file) => {
          const ownership = resolveOwnership(file);
          const color = ownershipColors[ownership];
          const directory = getDirectory(file.path);
          const showDirectoryHeader = directory !== lastDirectory;
          lastDirectory = directory;

          return (
            <div key={file.path}>
              {showDirectoryHeader && directory && (
                <div className="file-tree-tab__dir-header">{directory}/</div>
              )}

              <button
                className="file-tree-tab__file-row"
                onClick={() => toggleFile(file.path)}
              >
                <span
                  className="file-tree-tab__ownership-dot"
                  style={{ backgroundColor: color }}
                />
                <span className="file-tree-tab__filename">
                  {getFilename(file.path)}
                </span>
                <span className="file-tree-tab__preview-hint">
                  <IconEye size={12} />
                  <span>preview</span>
                </span>
              </button>

              {expandedPath === file.path && (
                <div className="file-tree-tab__expanded">
                  <p className="file-tree-tab__expanded-path">{file.path}</p>
                  <div className="file-tree-tab__expanded-meta">
                    <Badge color={color} small>
                      {ownershipLabels[ownership]}
                    </Badge>
                    <span className="file-tree-tab__expanded-explanation">
                      {ownershipExplanations[ownership]}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

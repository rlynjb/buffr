"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { IconEye, IconRefresh, IconLink, IconCheck, IconX } from "@/components/icons";
import { DiffView } from "./diff-view";
import type { ReviewableChange } from "./review-banner";
import "./file-tree-tab.css";

interface FileTreeTabProps {
  generatedFiles: Array<{ path: string; content: string; ownership: string }>;
  editedPaths?: Set<string>;
  onFileEdit?: (path: string, content: string) => void;
  onFileReset?: (path: string) => void;
  onFileRegenerate?: (path: string) => void;
  regeneratingPaths?: Set<string>;
  fileSources?: Record<string, Array<{ label: string; url: string }>>;
  reviewableChanges?: ReviewableChange[];
  reviewDecisions?: Record<string, "accepted" | "rejected">;
  onReviewDecision?: (path: string, decision: "accepted" | "rejected") => void;
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
  const stripped = path.replace(/^\.dev\//, "");
  const segments = stripped.split("/");
  return segments.length > 1 ? segments[0] : "";
}

function getFilename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

export function FileTreeTab({
  generatedFiles,
  editedPaths,
  onFileEdit,
  onFileReset,
  onFileRegenerate,
  regeneratingPaths,
  fileSources,
  reviewableChanges,
  reviewDecisions,
  onReviewDecision,
}: FileTreeTabProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const toggleFile = (path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  };

  let lastDirectory = "";

  return (
    <div className="file-tree-tab">
      {/* Ownership legend */}
      <div className="file-tree-tab__legend">
        <p className="file-tree-tab__legend-desc">
          Each file has an ownership level that controls how buffr handles it during re-scans:
        </p>
        <div className="file-tree-tab__legend-grid">
          {(Object.keys(ownershipColors) as Ownership[]).map((key) => (
            <div key={key} className="file-tree-tab__legend-card">
              <div className="file-tree-tab__legend-card-header">
                <span
                  className="file-tree-tab__legend-swatch"
                  style={{ backgroundColor: ownershipColors[key] }}
                />
                <span className="file-tree-tab__legend-card-label">
                  {ownershipLabels[key]}
                </span>
              </div>
              <p className="file-tree-tab__legend-card-desc">
                {ownershipExplanations[key]}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* File list */}
      <div className="file-tree-tab__list">
        {generatedFiles.map((file) => {
          const ownership = resolveOwnership(file);
          const color = ownershipColors[ownership];
          const directory = getDirectory(file.path);
          const showDirectoryHeader = directory !== lastDirectory;
          lastDirectory = directory;
          const isEdited = editedPaths?.has(file.path) ?? false;
          const isMd = file.path.endsWith(".md");
          const isSystem = ownership === "system";
          const isEditable = isMd && !isSystem && !!onFileEdit;
          const isRegenerating = regeneratingPaths?.has(file.path) ?? false;
          const sources = fileSources?.[file.path];

          // Review mode
          const reviewChange = reviewableChanges?.find((c) => c.path === file.path);
          const decision = reviewDecisions?.[file.path];
          const hasPendingReview = !!reviewChange && !decision;

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
                {hasPendingReview && (
                  <span className="file-tree-tab__review-badge">Review</span>
                )}
                {decision === "accepted" && (
                  <span className="file-tree-tab__accepted-badge">Accepted</span>
                )}
                {decision === "rejected" && (
                  <span className="file-tree-tab__rejected-badge">Kept current</span>
                )}
                {isEdited && !reviewChange && (
                  <span className="file-tree-tab__edited-badge">Edited</span>
                )}
                <span className="file-tree-tab__preview-hint">
                  <IconEye size={12} />
                  <span>{hasPendingReview ? "review" : isEditable ? "edit" : "preview"}</span>
                </span>
              </button>

              {expandedPath === file.path && (
                <div className="file-tree-tab__expanded">
                  <div className="file-tree-tab__expanded-header">
                    <p className="file-tree-tab__expanded-path">{file.path}</p>
                    {isSystem && onFileRegenerate && !reviewChange && (
                      <button
                        className="file-tree-tab__regenerate-btn"
                        onClick={() => onFileRegenerate(file.path)}
                        disabled={isRegenerating}
                      >
                        <IconRefresh size={11} />
                        {isRegenerating ? "Regenerating..." : "Regenerate"}
                      </button>
                    )}
                    {isEdited && onFileReset && !reviewChange && (
                      <button
                        className="file-tree-tab__reset-btn"
                        onClick={() => onFileReset(file.path)}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="file-tree-tab__expanded-meta">
                    <Badge color={color} small>
                      {ownershipLabels[ownership]}
                    </Badge>
                    <span className="file-tree-tab__expanded-explanation">
                      {ownershipExplanations[ownership]}
                    </span>
                  </div>
                  {sources && sources.length > 0 && (
                    <div className="file-tree-tab__sources">
                      <span className="file-tree-tab__sources-label">Sources:</span>
                      {sources.map((s) => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="file-tree-tab__sources-link"
                        >
                          <IconLink size={10} />
                          {s.label}
                        </a>
                      ))}
                    </div>
                  )}

                  {/* Review mode: show diff with accept/reject */}
                  {reviewChange && !decision && (
                    <div className="file-tree-tab__review">
                      <div className="file-tree-tab__review-actions">
                        <button
                          className="file-tree-tab__review-accept"
                          onClick={() => onReviewDecision?.(file.path, "accepted")}
                        >
                          <IconCheck size={11} /> Accept changes
                        </button>
                        <button
                          className="file-tree-tab__review-reject"
                          onClick={() => onReviewDecision?.(file.path, "rejected")}
                        >
                          <IconX size={11} /> Keep current
                        </button>
                      </div>
                      <DiffView
                        oldContent={reviewChange.oldContent}
                        newContent={reviewChange.newContent}
                      />
                    </div>
                  )}

                  {/* Already reviewed — show decision with toggle */}
                  {reviewChange && decision && (
                    <div className="file-tree-tab__review-decided">
                      <span className={decision === "accepted" ? "file-tree-tab__decided-accept" : "file-tree-tab__decided-reject"}>
                        {decision === "accepted" ? "Changes accepted" : "Changes rejected \u2014 keeping current"}
                      </span>
                      <button
                        className="file-tree-tab__review-undo"
                        onClick={() => onReviewDecision?.(file.path, decision === "accepted" ? "rejected" : "accepted")}
                      >
                        Change
                      </button>
                    </div>
                  )}

                  {/* Normal content view (no review needed) */}
                  {!reviewChange && file.content && isMd && (
                    <div className="file-tree-tab__content">
                      {isEditable ? (
                        <textarea
                          className="file-tree-tab__editor"
                          value={file.content}
                          onChange={(e) => onFileEdit(file.path, e.target.value)}
                          spellCheck={false}
                        />
                      ) : (
                        <pre className="file-tree-tab__content-pre">
                          {file.content}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

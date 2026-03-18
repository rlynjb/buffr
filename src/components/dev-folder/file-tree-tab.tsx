"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { IconEye, IconRefresh, IconLink, IconCheck, IconX, IconPlus, IconTrash } from "@/components/icons";
import { DiffView } from "./diff-view";
import type { ReviewableChange } from "./review-banner";
import type { GapAnalysisEntry } from "@/lib/types";
import "./file-tree-tab.css";

interface FileTreeTabProps {
  generatedFiles: Array<{ path: string; content: string; ownership: string }>;
  editedPaths?: Set<string>;
  onFileEdit?: (path: string, content: string) => void;
  onFileReset?: (path: string) => void;
  onFileRegenerate?: (path: string) => void;
  onFileCreate?: (path: string, content: string, ownership: string) => void;
  onFileDelete?: (path: string) => void;
  onFileMove?: (oldPath: string, newPath: string) => void;
  regeneratingPaths?: Set<string>;
  fileSources?: Record<string, Array<{ label: string; url: string }>>;
  reviewableChanges?: ReviewableChange[];
  reviewDecisions?: Record<string, "accepted" | "rejected">;
  onReviewDecision?: (path: string, decision: "accepted" | "rejected") => void;
  gapAnalysis?: GapAnalysisEntry[];
  highlightedFilePath?: string | null;
  onHighlightClear?: () => void;
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

const fileDescriptions: Record<string, string> = {
  ".dev/context/PROJECT.md": "Project overview, stack, and architecture",
  ".dev/context/CONVENTIONS.md": "Coding conventions and style rules",
  ".dev/context/DECISIONS.md": "Architecture decision records (ADRs)",
  ".dev/industry/react.md": "React best practices",
  ".dev/industry/nextjs.md": "Next.js best practices",
  ".dev/industry/typescript.md": "TypeScript best practices",
  ".dev/industry/tailwind.md": "Tailwind CSS best practices",
  ".dev/industry/nodejs.md": "Node.js best practices",
  ".dev/industry/security.md": "Security standards and patterns",
  ".dev/industry/testing.md": "Testing standards and patterns",
  ".dev/standards/frontend.md": "Frontend architecture guidelines",
  ".dev/standards/backend.md": "Backend and API guidelines",
  ".dev/standards/css.md": "CSS and styling guidelines",
  ".dev/standards/typescript.md": "TypeScript project rules",
  ".dev/gap-analysis.md": "Industry vs project comparison",
  ".dev/prompts/audit.md": "Prompt template for code audits",
  ".dev/prompts/cleanup.md": "Prompt template for code cleanup",
  ".dev/prompts/new-feature.md": "Prompt template for new features",
  ".dev/templates/component.md": "Scaffold template for components",
  ".dev/templates/api-endpoint.md": "Scaffold template for API endpoints",
  ".dev/templates/test.md": "Scaffold template for tests",
  ".dev/adapters/CLAUDE.md": "Claude Code project config",
  ".dev/adapters/.cursorrules": "Cursor editor rules",
  ".dev/adapters/copilot-instructions.md": "GitHub Copilot instructions",
  ".dev/adapters/.windsurfrules": "Windsurf editor rules",
  ".dev/adapters/.aider.conf.yml": "Aider context config",
  ".dev/adapters/.continuerules": "Continue editor rules",
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
  onFileCreate,
  onFileDelete,
  onFileMove,
  regeneratingPaths,
  fileSources,
  reviewableChanges,
  reviewDecisions,
  onReviewDecision,
  gapAnalysis,
  highlightedFilePath,
  onHighlightClear,
}: FileTreeTabProps) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newFileDir, setNewFileDir] = useState("context");
  const [newFileName, setNewFileName] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [moveTargetDir, setMoveTargetDir] = useState("");

  const DIRECTORIES = ["context", "standards", "industry", "prompts", "templates", "adapters"];

  // Collect any custom directories from existing files
  const existingDirs = useMemo(() => {
    const dirs = new Set(DIRECTORIES);
    for (const f of generatedFiles) {
      const dir = getDirectory(f.path);
      if (dir) dirs.add(dir);
    }
    return Array.from(dirs);
  }, [generatedFiles]);

  const newFilePath = `.dev/${newFileDir}/${newFileName}${newFileName && !newFileName.endsWith(".md") ? ".md" : ""}`;

  const toggleFile = (path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  };

  // Auto-expand and scroll to highlighted file
  useEffect(() => {
    if (highlightedFilePath) {
      setExpandedPath(highlightedFilePath);
      requestAnimationFrame(() => {
        fileRefs.current[highlightedFilePath]?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
      const timer = setTimeout(() => onHighlightClear?.(), 2000);
      return () => clearTimeout(timer);
    }
  }, [highlightedFilePath, onHighlightClear]);

  // Sort files by directory so moved files group correctly
  const sortedFiles = useMemo(() => {
    return [...generatedFiles].sort((a, b) => {
      const dirA = getDirectory(a.path);
      const dirB = getDirectory(b.path);
      if (dirA !== dirB) return dirA.localeCompare(dirB);
      return a.path.localeCompare(b.path);
    });
  }, [generatedFiles]);

  // Build reverse map: file path → gap status counts
  const fileGapStatuses = useMemo(() => {
    if (!gapAnalysis) return {};
    const categoryFileMap: Record<string, string[]> = {
      "security":       [".dev/industry/security.md", ".dev/standards/backend.md"],
      "testing":        [".dev/industry/testing.md"],
      "architecture":   [".dev/standards/frontend.md", ".dev/standards/typescript.md"],
      "error-handling": [".dev/standards/backend.md"],
    };
    const result: Record<string, { aligned: number; partial: number; gap: number }> = {};
    for (const entry of gapAnalysis) {
      const candidates = categoryFileMap[entry.category];
      if (!candidates) continue;
      for (const filePath of candidates) {
        if (!result[filePath]) result[filePath] = { aligned: 0, partial: 0, gap: 0 };
        result[filePath][entry.status]++;
      }
    }
    return result;
  }, [gapAnalysis]);

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

      {/* Create new file */}
      {onFileCreate && (
        <div className="file-tree-tab__create-section">
          {!showCreateForm ? (
            <button
              className="file-tree-tab__create-trigger"
              onClick={() => setShowCreateForm(true)}
            >
              <IconPlus size={12} /> New file
            </button>
          ) : (
            <div className="file-tree-tab__create-form">
              <div className="file-tree-tab__create-path-row">
                <span className="file-tree-tab__create-prefix">.dev/</span>
                <select
                  value={newFileDir}
                  onChange={(e) => setNewFileDir(e.target.value)}
                  className="file-tree-tab__create-dir-select"
                >
                  {existingDirs.map((dir) => (
                    <option key={dir} value={dir}>{dir}/</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="filename.md"
                  className="file-tree-tab__create-name"
                  autoFocus
                />
              </div>
              <p className="file-tree-tab__create-preview">{newFilePath}</p>
              <textarea
                value={newFileContent}
                onChange={(e) => setNewFileContent(e.target.value)}
                placeholder="File content..."
                rows={6}
                className="file-tree-tab__create-editor"
              />
              <div className="file-tree-tab__create-actions">
                <button
                  className="file-tree-tab__create-cancel"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewFileDir("context");
                    setNewFileName("");
                    setNewFileContent("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="file-tree-tab__create-save"
                  disabled={
                    !newFileName.trim() ||
                    !newFileContent.trim() ||
                    generatedFiles.some((f) => f.path === newFilePath)
                  }
                  onClick={() => {
                    onFileCreate(newFilePath, newFileContent, "user");
                    setShowCreateForm(false);
                    const createdPath = newFilePath;
                    setNewFileDir("context");
                    setNewFileName("");
                    setNewFileContent("");
                    setExpandedPath(createdPath);
                  }}
                >
                  Create file
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* File list */}
      <div className="file-tree-tab__list">
        {sortedFiles.map((file) => {
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

          const gapStatus = fileGapStatuses[file.path];

          return (
            <div key={file.path} ref={(el) => { fileRefs.current[file.path] = el; }}>
              {showDirectoryHeader && directory && (
                <div className="file-tree-tab__dir-header">{directory}/</div>
              )}

              <button
                className={`file-tree-tab__file-row${highlightedFilePath === file.path ? " file-tree-tab__file-row--highlighted" : ""}`}
                onClick={() => toggleFile(file.path)}
              >
                <span
                  className="file-tree-tab__ownership-dot"
                  style={{ backgroundColor: color }}
                />
                <span className="file-tree-tab__filename">
                  {getFilename(file.path)}
                  {fileDescriptions[file.path] && (
                    <span className="file-tree-tab__file-desc">
                      {fileDescriptions[file.path]}
                    </span>
                  )}
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
                {gapStatus && (
                  <span className="file-tree-tab__gap-indicators">
                    {gapStatus.gap > 0 && (
                      <span className="file-tree-tab__gap-dot file-tree-tab__gap-dot--gap" title={`${gapStatus.gap} gap(s)`}>
                        {gapStatus.gap}
                      </span>
                    )}
                    {gapStatus.partial > 0 && (
                      <span className="file-tree-tab__gap-dot file-tree-tab__gap-dot--partial" title={`${gapStatus.partial} partial`}>
                        {gapStatus.partial}
                      </span>
                    )}
                    {gapStatus.aligned > 0 && (
                      <span className="file-tree-tab__gap-dot file-tree-tab__gap-dot--aligned" title={`${gapStatus.aligned} aligned`}>
                        {gapStatus.aligned}
                      </span>
                    )}
                  </span>
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
                    {onFileMove && !isSystem && !reviewChange && (
                      movingPath === file.path ? (
                        <span className="file-tree-tab__move-confirm">
                          <select
                            value={moveTargetDir}
                            onChange={(e) => setMoveTargetDir(e.target.value)}
                            className="file-tree-tab__move-select"
                          >
                            {existingDirs
                              .filter((d) => d !== getDirectory(file.path))
                              .map((dir) => (
                                <option key={dir} value={dir}>{dir}/</option>
                              ))}
                          </select>
                          <button
                            className="file-tree-tab__move-apply"
                            onClick={() => {
                              const filename = getFilename(file.path);
                              const newPath = `.dev/${moveTargetDir}/${filename}`;
                              if (!generatedFiles.some((f) => f.path === newPath)) {
                                onFileMove(file.path, newPath);
                                setExpandedPath(newPath);
                              }
                              setMovingPath(null);
                            }}
                          >
                            Move
                          </button>
                          <button
                            className="file-tree-tab__move-cancel"
                            onClick={() => setMovingPath(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="file-tree-tab__move-btn"
                          onClick={() => {
                            const currentDir = getDirectory(file.path);
                            const firstOther = existingDirs.find((d) => d !== currentDir) || existingDirs[0];
                            setMoveTargetDir(firstOther);
                            setMovingPath(file.path);
                          }}
                        >
                          Move
                        </button>
                      )
                    )}
                    {onFileDelete && !isSystem && !reviewChange && (
                      confirmDeletePath === file.path ? (
                        <span className="file-tree-tab__delete-confirm">
                          <span className="file-tree-tab__delete-confirm-text">Delete?</span>
                          <button
                            className="file-tree-tab__delete-yes"
                            onClick={() => {
                              onFileDelete(file.path);
                              setConfirmDeletePath(null);
                              setExpandedPath(null);
                            }}
                          >
                            Yes
                          </button>
                          <button
                            className="file-tree-tab__delete-no"
                            onClick={() => setConfirmDeletePath(null)}
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          className="file-tree-tab__delete-btn"
                          onClick={() => setConfirmDeletePath(file.path)}
                        >
                          <IconTrash size={11} /> Delete
                        </button>
                      )
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

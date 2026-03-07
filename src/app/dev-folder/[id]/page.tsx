"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  IconBack,
  IconLayers,
  IconScan,
  IconRefresh,
  IconGitHub,
  IconLoader,
} from "@/components/icons";
import { getProject, listScanResults, getScanResult, triggerScan, updateProject, pushDevFiles, detectDevFolder, updateScanResult, getStandard, seedIndustryKB } from "@/lib/api";
import type { Project, ScanResult } from "@/lib/types";
import { useProvider } from "@/context/provider-context";
import { OverviewTab } from "@/components/dev-folder/overview-tab";
import { GapTab } from "@/components/dev-folder/gap-tab";
import { FileTreeTab } from "@/components/dev-folder/file-tree-tab";
import { AdaptersTab } from "@/components/dev-folder/adapters-tab";
import { ReviewBanner } from "@/components/dev-folder/review-banner";
import "./page.css";

type Section = "overview" | "gap" | "files" | "adapters";
type ScanPhase = "idle" | "scanning" | "analyzing" | "generating" | "done" | "failed";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "gap", label: "Gap Analysis" },
  { id: "files", label: "File Tree" },
  { id: "adapters", label: "Adapters" },
];

const SCAN_PHASES: ScanPhase[] = ["scanning", "analyzing", "generating"];

export default function DevFolderPage() {
  const params = useParams();
  const id = params.id as string;
  const { selected: selectedProvider } = useProvider();
  const [project, setProject] = useState<Project | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const proj = await getProject(id);
        setProject(proj);

        if (proj.devFolder?.scanResultId) {
          try {
            const result = await getScanResult(proj.devFolder.scanResultId);
            setScanResult(result);
            setScanPhase("done");
          } catch {
            const results = await listScanResults(id);
            if (results.length > 0) {
              setScanResult(results[0]);
              setScanPhase("done");
            }
          }
        } else {
          const results = await listScanResults(id);
          if (results.length > 0) {
            setScanResult(results[0]);
            setScanPhase(results[0].status === "done" ? "done" : results[0].status as ScanPhase);
          } else if (proj.githubRepo) {
            // No scans exist — check if repo already has .dev/ folder
            try {
              const imported = await detectDevFolder(proj.id);
              if (imported) {
                setScanResult(imported);
                setScanPhase("done");
                setProject({ ...proj, devFolder: { status: "generated", lastScan: imported.updatedAt, scanResultId: imported.id, gapScore: null, adapters: imported.detectedAdapters } });
              }
            } catch {
              // Detection failed — user can still scan manually
            }
          }
        }
      } catch (err) {
        console.error("Failed to load dev-folder data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const pollScanResult = useCallback(async (scanId: string) => {
    const poll = async () => {
      try {
        const result = await getScanResult(scanId);
        const status = result.status as ScanPhase;

        if (status === "done") {
          setScanResult(result);
          setScanPhase("done");
          setScanError(null);
          if (project) {
            try {
              await updateProject(project.id, {
                devFolder: {
                  status: "generated",
                  lastScan: result.updatedAt,
                  scanResultId: result.id,
                  gapScore: {
                    aligned: result.gapAnalysis.filter((g) => g.status === "aligned").length,
                    partial: result.gapAnalysis.filter((g) => g.status === "partial").length,
                    gap: result.gapAnalysis.filter((g) => g.status === "gap").length,
                  },
                  adapters: result.detectedAdapters,
                },
              });
            } catch {
              // Non-critical — project update failed
            }
          }
          return;
        }

        if (status === "failed") {
          setScanPhase("failed");
          setScanError(result.error || "Scan failed");
          return;
        }

        setScanPhase(status);
        setTimeout(poll, 2000);
      } catch {
        setTimeout(poll, 3000);
      }
    };
    poll();
  }, [project]);

  // ── Review state ──
  const [previousScan, setPreviousScan] = useState<ScanResult | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, "accepted" | "rejected">>({});

  const reviewableChanges = useMemo(() => {
    if (!previousScan || !scanResult) return [];
    return scanResult.generatedFiles
      .filter((f) => f.ownership === "reviewable")
      .map((newFile) => {
        const oldFile = previousScan.generatedFiles.find((o) => o.path === newFile.path);
        const oldContent = oldFile?.content ?? "";
        return { path: newFile.path, oldContent, newContent: newFile.content };
      })
      .filter((f) => f.oldContent !== f.newContent);
  }, [previousScan, scanResult]);

  const allReviewed = reviewableChanges.length > 0 &&
    reviewableChanges.every((f) => f.path in reviewDecisions);

  function handleReviewDecision(path: string, decision: "accepted" | "rejected") {
    setReviewDecisions((prev) => ({ ...prev, [path]: decision }));
  }

  async function handleApplyReview() {
    if (!scanResult || !previousScan) return;
    setPushing(true);
    try {
      // For rejected files, revert to old content
      const updatedFiles = scanResult.generatedFiles.map((f) => {
        if (f.ownership !== "reviewable") return f;
        if (reviewDecisions[f.path] === "rejected") {
          const oldFile = previousScan.generatedFiles.find((o) => o.path === f.path);
          return oldFile ? { ...f, content: oldFile.content } : f;
        }
        return f;
      });

      await updateScanResult(scanResult.id, { generatedFiles: updatedFiles });
      setScanResult({ ...scanResult, generatedFiles: updatedFiles });
      await pushDevFiles(scanResult.id);

      // Clear review state
      setPreviousScan(null);
      setReviewDecisions({});
    } catch (err) {
      console.error("Apply & push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  async function handleScan() {
    if (!project) return;

    const isRescan = scanResult !== null;

    // Capture previous scan for comparison on re-scans
    if (isRescan && scanResult) {
      setPreviousScan(scanResult);
    }

    setScanPhase("scanning");
    setScanError(null);
    setEditedFiles({});
    setReviewDecisions({});

    try {
      const result = await triggerScan(
        project.id,
        selectedProvider || undefined,
        isRescan ? true : undefined,
      );
      setScanResult(result);
      if (result.status === "done") {
        setScanPhase("done");
      } else {
        pollScanResult(result.id);
      }
    } catch (err) {
      setScanPhase("failed");
      setScanError(err instanceof Error ? err.message : "Failed to start scan");
    }
  }

  const [pushing, setPushing] = useState(false);
  const [editedFiles, setEditedFiles] = useState<Record<string, string>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const editedPaths = useMemo(() => new Set(Object.keys(editedFiles)), [editedFiles]);
  const hasEdits = editedPaths.size > 0;

  // Merge edits into generatedFiles for display and push
  const mergedFiles = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.generatedFiles.map((f) =>
      f.path in editedFiles ? { ...f, content: editedFiles[f.path] } : f,
    );
  }, [scanResult, editedFiles]);

  function handleFileEdit(path: string, content: string) {
    setEditedFiles((prev) => ({ ...prev, [path]: content }));

    // Debounced persist to backend
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!scanResult) return;
      const updated = scanResult.generatedFiles.map((f) =>
        f.path === path ? { ...f, content } : f.path in editedFiles ? { ...f, content: editedFiles[f.path] } : f,
      );
      updateScanResult(scanResult.id, { generatedFiles: updated }).catch(() => {});
    }, 1000);
  }

  const [regeneratingPaths, setRegeneratingPaths] = useState<Set<string>>(new Set());
  const [fileSources, setFileSources] = useState<Record<string, Array<{ label: string; url: string }>>>({});

  // Technologies backed by the industry KB (can be regenerated)
  const KB_TECHNOLOGIES = new Set(["react", "nextjs", "typescript", "tailwind", "nodejs"]);

  // Extract technology key from industry file path (e.g. ".dev/industry/react.md" → "react")
  // Returns null for non-KB files like security.md, testing.md
  function getTechFromPath(path: string): string | null {
    const match = path.match(/^\.dev\/industry\/(.+)\.md$/);
    if (!match) return null;
    return KB_TECHNOLOGIES.has(match[1]) ? match[1] : null;
  }

  // Load sources for industry files when scan result is available
  useEffect(() => {
    if (!scanResult) return;
    const industryFiles = scanResult.generatedFiles.filter(
      (f) => f.ownership === "system" && getTechFromPath(f.path),
    );
    if (industryFiles.length === 0) return;

    async function loadSources() {
      const sources: Record<string, Array<{ label: string; url: string }>> = {};
      let seeded = false;
      for (const file of industryFiles) {
        const tech = getTechFromPath(file.path);
        if (!tech) continue;
        try {
          const standard = await getStandard(tech);
          if (standard.sources?.length) {
            sources[file.path] = standard.sources;
          }
        } catch {
          // Standard not found — seed KB once then retry
          if (!seeded) {
            try {
              await seedIndustryKB(true);
              seeded = true;
              const standard = await getStandard(tech);
              if (standard.sources?.length) {
                sources[file.path] = standard.sources;
              }
            } catch {
              // Seed or retry failed — skip
            }
          }
        }
      }
      setFileSources(sources);
    }
    loadSources();
  }, [scanResult]);

  async function handleFileRegenerate(path: string) {
    if (!scanResult) return;
    const tech = getTechFromPath(path);
    if (!tech) return;

    setRegeneratingPaths((prev) => new Set(prev).add(path));
    try {
      // Seed KB with latest standards, then fetch the updated standard
      await seedIndustryKB(true);
      const standard = await getStandard(tech);
      const updatedFiles = scanResult.generatedFiles.map((f) =>
        f.path === path ? { ...f, content: standard.content } : f,
      );
      await updateScanResult(scanResult.id, { generatedFiles: updatedFiles });
      setScanResult({ ...scanResult, generatedFiles: updatedFiles });
      if (standard.sources?.length) {
        setFileSources((prev) => ({ ...prev, [path]: standard.sources }));
      }
    } catch (err) {
      console.error("Regenerate failed:", err);
    } finally {
      setRegeneratingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  function handleFileReset(path: string) {
    setEditedFiles((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });

    // Persist reset to backend
    if (scanResult) {
      const updated = scanResult.generatedFiles.map((f) =>
        f.path in editedFiles && f.path !== path ? { ...f, content: editedFiles[f.path] } : f,
      );
      updateScanResult(scanResult.id, { generatedFiles: updated }).catch(() => {});
    }
  }

  async function handlePush() {
    if (!scanResult) return;
    setPushing(true);
    try {
      // Persist any pending edits before pushing
      if (hasEdits) {
        await updateScanResult(scanResult.id, { generatedFiles: mergedFiles });
        setScanResult({ ...scanResult, generatedFiles: mergedFiles });
        setEditedFiles({});
      }
      await pushDevFiles(scanResult.id);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  if (loading) {
    return (
      <div className="dev-folder__skeleton">
        <div className="dev-folder__skeleton-bar" />
        <div className="dev-folder__skeleton-block" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="dev-folder__not-found">
        <p className="dev-folder__not-found-text">Project not found.</p>
      </div>
    );
  }

  const isScanning = scanPhase === "scanning" || scanPhase === "analyzing" || scanPhase === "generating";
  const hasReviewableChanges = reviewableChanges.length > 0;

  return (
    <div className="dev-folder">
      <Link href={`/project/${project.id}`} className="dev-folder__back">
        <IconBack size={14} /> {project.name}
      </Link>

      {/* Header */}
      <div className="dev-folder__header">
        <div className="dev-folder__title-row">
          <span className="dev-folder__title-icon"><IconLayers size={18} /></span>
          <span className="dev-folder__title">
            .dev/ <span className="dev-folder__title-for">for</span>{" "}
            <span className="dev-folder__title-name">{project.name}</span>
          </span>
        </div>
        <p className="dev-folder__subtitle">
          Project intelligence — industry standards, conventions, gap analysis, and AI tool configs
        </p>
        {scanPhase === "done" && (
          <div className="dev-folder__header-actions">
            {scanResult && (
              <span className="dev-folder__last-scan">
                Scanned {new Date(scanResult.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={handleScan}>
              <IconRefresh size={14} /> Re-scan
            </Button>
            {hasReviewableChanges ? (
              <Badge color="#fbbf24" small>Review pending</Badge>
            ) : (
              <Button size="sm" variant="primary" onClick={handlePush} disabled={pushing}>
                {pushing ? <IconLoader size={14} /> : <IconGitHub size={14} />}
                {pushing ? "Pushing..." : "Push to Repo"}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Scan CTA — no .dev/ exists */}
      {scanPhase === "idle" && (
        <div className="dev-folder__scan-cta">
          <div className="dev-folder__scan-cta-icon"><IconScan size={24} /></div>
          <h3 className="dev-folder__scan-cta-title">No .dev/ folder detected</h3>
          <p className="dev-folder__scan-cta-desc">
            Scan your repo to generate a complete project intelligence folder — industry standards,
            coding conventions, gap analysis, and AI tool configs.
          </p>
          <Button variant="primary" onClick={handleScan}>
            <IconScan size={14} /> Scan Repository
          </Button>
        </div>
      )}

      {/* Scan error */}
      {scanPhase === "failed" && (
        <div className="dev-folder__scan-error">
          <p className="dev-folder__scan-error-text">
            {scanError || "Scan failed. Please try again."}
          </p>
          <Button size="sm" onClick={handleScan}>Retry</Button>
        </div>
      )}

      {/* Scanning progress */}
      {isScanning && (
        <div className="dev-folder__scan-progress">
          <div className="dev-folder__scan-progress-header">
            <IconLoader size={14} />
            <span className="dev-folder__scan-progress-label">
              {scanPhase === "scanning"
                ? "Scanning repository..."
                : scanPhase === "analyzing"
                  ? "Analyzing patterns & conventions..."
                  : "Generating .dev/ files..."}
            </span>
          </div>
          <div className="dev-folder__scan-progress-bars">
            {SCAN_PHASES.map((phase, i) => {
              const currentIdx = SCAN_PHASES.indexOf(scanPhase as typeof phase);
              const pct = i < currentIdx ? 100 : i === currentIdx ? 60 : 0;
              return (
                <div key={phase} className="dev-folder__scan-progress-step">
                  <div className="dev-folder__scan-progress-track">
                    <div
                      className={`dev-folder__scan-progress-fill ${
                        pct > 0
                          ? "dev-folder__scan-progress-fill--active"
                          : "dev-folder__scan-progress-fill--pending"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="dev-folder__scan-progress-phase">{phase}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main content — tabs */}
      {scanPhase === "done" && scanResult && (
        <>
          <div className="dev-folder__usage">
            <p className="dev-folder__usage-text">
              The <strong>.dev/</strong> folder lives in your repo and gives AI coding tools
              (Claude Code, Cursor, Copilot) project-aware context. It contains industry
              best practices, your coding conventions, gap analysis, and ready-to-use
              prompt templates. Push it to your repo, and any AI tool that reads project
              files will automatically pick up the context.
            </p>
          </div>

          {hasReviewableChanges && (
            <ReviewBanner
              changes={reviewableChanges}
              decisions={reviewDecisions}
              onApply={handleApplyReview}
              applying={pushing}
            />
          )}

          <div className="dev-folder__tabs">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={`dev-folder__tab ${
                  activeSection === s.id
                    ? "dev-folder__tab--active"
                    : "dev-folder__tab--inactive"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="dev-folder__tab-content">
            {activeSection === "overview" && <OverviewTab scanResult={scanResult} />}
            {activeSection === "gap" && <GapTab gapAnalysis={scanResult.gapAnalysis} />}
            {activeSection === "files" && (
              <FileTreeTab
                generatedFiles={mergedFiles}
                editedPaths={editedPaths}
                onFileEdit={handleFileEdit}
                onFileReset={handleFileReset}
                onFileRegenerate={handleFileRegenerate}
                regeneratingPaths={regeneratingPaths}
                fileSources={fileSources}
                reviewableChanges={reviewableChanges}
                reviewDecisions={reviewDecisions}
                onReviewDecision={handleReviewDecision}
              />
            )}
            {activeSection === "adapters" && <AdaptersTab detectedAdapters={scanResult.detectedAdapters} />}
          </div>
        </>
      )}
    </div>
  );
}

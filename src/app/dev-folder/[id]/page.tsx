"use client";

import { useEffect, useState, useCallback } from "react";
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
import { getProject, listScanResults, getScanResult, triggerScan, updateProject, pushDevFiles, detectDevFolder } from "@/lib/api";
import type { Project, ScanResult } from "@/lib/types";
import { useProvider } from "@/context/provider-context";
import { OverviewTab } from "@/components/dev-folder/overview-tab";
import { GapTab } from "@/components/dev-folder/gap-tab";
import { FileTreeTab } from "@/components/dev-folder/file-tree-tab";
import { AdaptersTab } from "@/components/dev-folder/adapters-tab";
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

  async function handleScan() {
    if (!project) return;
    setScanPhase("scanning");
    setScanError(null);
    try {
      const result = await triggerScan(project.id, selectedProvider || undefined);
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

  async function handlePush() {
    if (!scanResult) return;
    setPushing(true);
    try {
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

  return (
    <div className="dev-folder">
      <Link href={`/project/${project.id}`} className="dev-folder__back">
        <IconBack size={14} /> {project.name}
      </Link>

      {/* Header */}
      <div className="dev-folder__header">
        <div>
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
        </div>
        <div className="dev-folder__header-actions">
          {scanPhase === "done" && (
            <>
              <Button size="sm" variant="secondary" onClick={handleScan}>
                <IconRefresh size={14} /> Re-scan
              </Button>
              <Button size="sm" variant="primary" onClick={handlePush} disabled={pushing}>
                {pushing ? <IconLoader size={14} /> : <IconGitHub size={14} />}
                {pushing ? "Pushing..." : "Push to Repo"}
              </Button>
            </>
          )}
        </div>
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
            {activeSection === "files" && <FileTreeTab generatedFiles={scanResult.generatedFiles} />}
            {activeSection === "adapters" && <AdaptersTab detectedAdapters={scanResult.detectedAdapters} />}
          </div>
        </>
      )}
    </div>
  );
}

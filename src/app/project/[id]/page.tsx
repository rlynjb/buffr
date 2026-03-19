"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ResumeCard } from "@/components/session/resume-card";
import { EndSessionModal } from "@/components/session/end-session-modal";
import { getProject } from "@/lib/api";
import type { Project } from "@/lib/types";
import type { NextAction } from "@/lib/next-actions";
import "./page.css";

export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  // Use cached project data from sessionStorage for instant display after import
  const [project, setProject] = useState<Project | null>(() => {
    try {
      const cached = sessionStorage.getItem(`buffr-project-${id}`);
      if (cached) {
        sessionStorage.removeItem(`buffr-project-${id}`);
        return JSON.parse(cached) as Project;
      }
    } catch { /* ignore */ }
    return null;
  });
  const [loading, setLoading] = useState(!project);
  const [showEndSession, setShowEndSession] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const actionsRef = useRef<NextAction[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const data = await getProject(id);
        setProject(data);
      } catch (err) {
        console.error("Failed to load project:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, refreshKey]);

  if (loading) {
    return (
      <div className="project-page__skeleton">
        <div className="project-page__skeleton-bar" />
        <div className="project-page__skeleton-block" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="project-page__not-found">
        <p className="project-page__not-found-text">Project not found.</p>
      </div>
    );
  }

  return (
    <>
      <ResumeCard
        key={refreshKey}
        project={project}
        onEndSession={() => setShowEndSession(true)}
        onActionsChange={(a) => { actionsRef.current = a; }}
      />
      <EndSessionModal
        open={showEndSession}
        onClose={() => setShowEndSession(false)}
        project={project}
        currentActions={actionsRef.current}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ResumeCard } from "@/components/session/resume-card";
import { EndSessionModal } from "@/components/session/end-session-modal";
import { getProject } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEndSession, setShowEndSession] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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
      <div className="space-y-4">
        <div className="h-8 w-48 rounded bg-card animate-pulse" />
        <div className="h-32 rounded-xl border border-border bg-card animate-pulse" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-muted">Project not found.</p>
      </div>
    );
  }

  return (
    <>
      <ResumeCard
        key={refreshKey}
        project={project}
        onEndSession={() => setShowEndSession(true)}
      />
      <EndSessionModal
        open={showEndSession}
        onClose={() => setShowEndSession(false)}
        project={project}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
    </>
  );
}

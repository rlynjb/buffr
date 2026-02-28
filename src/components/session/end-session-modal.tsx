"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconLoader, IconSparkle, SourceIcon, sourceColor } from "@/components/icons";
import { createSession, updateProject, summarizeSession, suggestNextStep, detectIntent, executeToolAction } from "@/lib/api";
import { getToolForCapability } from "@/lib/data-sources";
import { useProvider } from "@/context/provider-context";
import type { Project } from "@/lib/types";

interface EndSessionModalProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  onSaved: () => void;
}

export function EndSessionModal({
  open,
  onClose,
  project,
  onSaved,
}: EndSessionModalProps) {
  const [phase, setPhase] = useState<"fetching" | "summarizing" | "ready">("fetching");
  const [goal, setGoal] = useState("");
  const [whatChanged, setWhatChanged] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [blockers, setBlockers] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiLabel, setAiLabel] = useState("");
  const { providers, selected } = useProvider();

  const hasLLM = providers.length > 0;
  const sources = project.dataSources || (project.githubRepo ? ["github"] : []);

  useEffect(() => {
    if (!open) return;
    setPhase("fetching");
    setGoal("");
    setWhatChanged("");
    setNextStep("");
    setBlockers("");
    setAiLabel("");

    if (!hasLLM || sources.length === 0) {
      setPhase("ready");
      return;
    }

    let cancelled = false;

    async function fetchAndSummarize() {
      // Phase 1: Fetch activity from connected sources
      const activityItems: Array<{ title: string; source: string; timestamp?: string }> = [];

      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // last 24h

        const fetches = sources.map(async (source) => {
          // Try fetching commits (GitHub)
          if (source === "github" && project.githubRepo) {
            const [owner, repo] = project.githubRepo.split("/");
            const commitTool = getToolForCapability(source, "list_commits");
            if (commitTool) {
              try {
                const res = await executeToolAction(commitTool, { owner, repo, since, limit: 15 });
                if (res.ok && res.result) {
                  const commits = res.result as Array<{ message?: string; sha?: string; date?: string }>;
                  for (const c of commits) {
                    if (c.message) {
                      activityItems.push({
                        title: c.message.split("\n")[0],
                        source: "github",
                        timestamp: c.date,
                      });
                    }
                  }
                }
              } catch {
                // Commits fetch failed — continue
              }
            }
          }

          // Try fetching recent items (issues/tasks)
          const activityTool = getToolForCapability(source, "list_recent_activity");
          if (activityTool) {
            try {
              const params: Record<string, unknown> = {};
              if (source === "github" && project.githubRepo) {
                const [owner, repo] = project.githubRepo.split("/");
                params.owner = owner;
                params.repo = repo;
                params.limit = 5;
              }
              const res = await executeToolAction(activityTool, params);
              if (res.ok && res.result) {
                const data = res.result as { items?: Array<{ title?: string; id?: string }> };
                if (data.items) {
                  for (const item of data.items.slice(0, 5)) {
                    if (item.title) {
                      activityItems.push({ title: item.title, source });
                    }
                  }
                }
              }
            } catch {
              // Activity fetch failed — continue
            }
          }
        });

        await Promise.all(fetches);
      } catch {
        // Fetch phase failed — fall through to ready with empty fields
      }

      if (cancelled) return;

      // Phase 2: Summarize with AI
      if (activityItems.length > 0) {
        setPhase("summarizing");

        try {
          const summary = await summarizeSession(activityItems, selected);
          if (cancelled) return;

          if (summary.goal) {
            setGoal(summary.goal);
          }
          if (summary.bullets.length > 0) {
            setWhatChanged(summary.bullets.map((b) => `• ${b}`).join("\n"));
          }

          // Also try suggesting next step
          try {
            const suggestion = await suggestNextStep(
              summary.goal || "",
              summary.bullets.join("\n"),
              "",
              `${project.name} (${project.phase}): ${project.description}`,
              "",
              selected,
            );
            if (!cancelled && suggestion.suggestedNextStep) {
              setNextStep(suggestion.suggestedNextStep);
            }
          } catch {
            // Next step suggestion is optional
          }

          setAiLabel(
            `AI-generated from ${activityItems.length} item${activityItems.length !== 1 ? "s" : ""} across ${sources.length} source${sources.length !== 1 ? "s" : ""}`
          );
        } catch {
          // Summarization failed — show empty fields
          setAiLabel("");
        }
      }

      if (!cancelled) {
        setPhase("ready");
      }
    }

    fetchAndSummarize();
    return () => { cancelled = true; };
  }, [open]);

  async function handleAutoFillChanges() {
    if (!whatChanged.trim()) return;
    try {
      const items = whatChanged
        .split("\n")
        .map((s) => s.replace(/^[•\-]\s*/, "").trim())
        .filter(Boolean)
        .map((title) => ({ title, source: "session" }));
      const result = await summarizeSession(items, selected);
      if (result.bullets.length > 0) {
        setWhatChanged(result.bullets.map((b) => `• ${b}`).join("\n"));
      }
    } catch (err) {
      console.error("Auto-fill failed:", err);
    }
  }

  async function handleSuggestNext() {
    try {
      const result = await suggestNextStep(
        goal,
        whatChanged,
        nextStep,
        `${project.name} (${project.phase}): ${project.description}`,
        "",
        selected,
      );
      if (result.suggestedNextStep) {
        setNextStep(result.suggestedNextStep);
      }
    } catch (err) {
      console.error("Suggest failed:", err);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const changes = whatChanged
        .split("\n")
        .map((s) => s.replace(/^[•\-]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 5);

      let detectedIntentValue: string | undefined;
      if (hasLLM && goal && changes.length > 0) {
        try {
          const intentResult = await detectIntent(goal, changes.join(", "), project.phase, selected);
          detectedIntentValue = intentResult.intent;
        } catch {
          // Intent detection is optional
        }
      }

      const session = await createSession({
        projectId: project.id,
        goal,
        whatChanged: changes,
        nextStep,
        blockers: blockers || null,
        detectedIntent: detectedIntentValue,
        suggestedNextStep: nextStep || undefined,
      });

      await updateProject(project.id, { lastSessionId: session.id });

      onSaved();
      onClose();
    } catch (err) {
      console.error("Failed to save session:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="End Session">
      {/* Loading phases */}
      {phase !== "ready" && (
        <div className="py-8 text-center">
          <div className="flex items-center justify-center gap-2 text-sm text-zinc-400 mb-3">
            <IconLoader size={14} />
            {phase === "fetching"
              ? `Fetching activity from ${sources.length} source${sources.length !== 1 ? "s" : ""}...`
              : "Summarizing with AI..."}
          </div>
          <div className="flex justify-center gap-2">
            {sources.map((s) => (
              <Badge key={s} color={sourceColor(s)}>
                <SourceIcon source={s} size={10} /> {s}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Ready phase */}
      {phase === "ready" && (
        <div className="space-y-4 animate-fadeIn">
          {aiLabel && (
            <div className="flex items-center gap-1.5 text-[11px] text-purple-400/70">
              <IconSparkle size={10} /> {aiLabel}
            </div>
          )}

          <Input
            label="Goal (1 sentence)"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What were you working on?"
          />

          {/* What Changed — with Accept/Clear */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                What Changed
              </label>
              <div className="flex gap-1">
                {hasLLM && whatChanged.trim() && (
                  <button
                    onClick={handleAutoFillChanges}
                    className="px-1.5 py-0.5 rounded text-[10px] text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer"
                  >
                    AI Summarize
                  </button>
                )}
                <button
                  onClick={() => setWhatChanged("")}
                  className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>
            <textarea
              value={whatChanged}
              onChange={(e) => setWhatChanged(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-colors"
              placeholder="What did you change? (one per line)"
            />
          </div>

          {/* Next Step — with Accept/Clear */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                Next Step
              </label>
              <div className="flex gap-1">
                {hasLLM && goal.trim() && (
                  <button
                    onClick={handleSuggestNext}
                    className="px-1.5 py-0.5 rounded text-[10px] text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer"
                  >
                    AI Suggest
                  </button>
                )}
                <button
                  onClick={() => setNextStep("")}
                  className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>
            <textarea
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-zinc-200 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-colors"
              placeholder="What's next?"
            />
          </div>

          <Input
            label="Blockers (optional)"
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            placeholder="Anything blocking progress?"
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!goal.trim()}>
              Save Session
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

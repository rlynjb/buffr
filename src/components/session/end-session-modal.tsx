"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconLoader, IconSparkle, SourceIcon, sourceColor } from "@/components/icons";
import { createSession, updateProject, summarizeSession, suggestNextStep, detectIntent } from "@/lib/api";
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

  // Multi-phase loading when modal opens
  useEffect(() => {
    if (!open) return;
    setPhase("fetching");
    setGoal("");
    setWhatChanged("");
    setNextStep("");
    setBlockers("");
    setAiLabel("");

    if (!hasLLM) {
      // No LLM — skip straight to ready
      setPhase("ready");
      return;
    }

    const t1 = setTimeout(() => setPhase("summarizing"), 1200);
    const t2 = setTimeout(() => {
      setPhase("ready");
      setAiLabel(`AI-ready — connected to ${sources.length} source${sources.length !== 1 ? "s" : ""}`);
    }, 2400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [open]);

  async function handleAutoFillChanges() {
    if (!whatChanged.trim()) return;
    try {
      const items = whatChanged
        .split("\n")
        .map((s) => s.trim())
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
            <input
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
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

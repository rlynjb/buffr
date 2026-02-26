"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
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
  const [goal, setGoal] = useState("");
  const [whatChanged, setWhatChanged] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [blockers, setBlockers] = useState("");
  const [saving, setSaving] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const { providers, selected } = useProvider();

  const hasLLM = providers.length > 0;

  async function handleAutoFill() {
    if (!whatChanged.trim()) return;
    setSummarizing(true);
    try {
      const items = whatChanged
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title) => ({ title, source: "session" }));
      const result = await summarizeSession(items, selected);
      if (result.bullets.length > 0) {
        setWhatChanged(result.bullets.join("\n"));
      }
    } catch (err) {
      console.error("Auto-fill failed:", err);
    } finally {
      setSummarizing(false);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
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
    } finally {
      setSuggesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const changes = whatChanged
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);

      // Detect intent in background (non-blocking)
      let detectedIntentValue: string | undefined;
      if (hasLLM && goal && changes.length > 0) {
        try {
          const intentResult = await detectIntent(goal, changes.join(", "), project.phase, selected);
          detectedIntentValue = intentResult.intent;
        } catch {
          // Intent detection is optional — don't block save
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

      setGoal("");
      setWhatChanged("");
      setNextStep("");
      setBlockers("");
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
      <div className="space-y-4">
        <Input
          label="What was your goal?"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Implemented user login flow"
        />

        <div>
          <TextArea
            label="What changed? (one per line, max 5)"
            value={whatChanged}
            onChange={(e) => setWhatChanged(e.target.value)}
            placeholder={"Added login page\nConnected auth API\nFixed session bug"}
            rows={3}
          />
          {hasLLM && whatChanged.trim() && (
            <button
              onClick={handleAutoFill}
              disabled={summarizing}
              className="mt-1 text-xs text-accent hover:underline disabled:opacity-50"
            >
              {summarizing ? "Summarizing..." : "Auto-fill with AI"}
            </button>
          )}
        </div>

        <div>
          <Input
            label="What's the next step?"
            value={nextStep}
            onChange={(e) => setNextStep(e.target.value)}
            placeholder="Add password reset flow"
          />
          {hasLLM && goal.trim() && (
            <button
              onClick={handleSuggest}
              disabled={suggesting}
              className="mt-1 text-xs text-accent hover:underline disabled:opacity-50"
            >
              {suggesting ? "Thinking..." : "AI Suggest"}
            </button>
          )}
        </div>

        <Input
          label="Any blockers? (optional)"
          value={blockers}
          onChange={(e) => setBlockers(e.target.value)}
          placeholder="Waiting on API key from team lead"
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!goal.trim()}>
            Save Session
          </Button>
        </div>
      </div>
    </Modal>
  );
}

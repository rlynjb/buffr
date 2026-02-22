"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { createSession, updateProject } from "@/lib/api";
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

  async function handleSave() {
    setSaving(true);
    try {
      const changes = whatChanged
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);

      const session = await createSession({
        projectId: project.id,
        goal,
        whatChanged: changes,
        nextStep,
        blockers: blockers || null,
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

        <TextArea
          label="What changed? (one per line, max 5)"
          value={whatChanged}
          onChange={(e) => setWhatChanged(e.target.value)}
          placeholder={"Added login page\nConnected auth API\nFixed session bug"}
          rows={3}
        />

        <Input
          label="What's the next step?"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
          placeholder="Add password reset flow"
        />

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

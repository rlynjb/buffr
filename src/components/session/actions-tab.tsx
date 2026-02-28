"use client";

import { useState } from "react";
import { SourceIcon, sourceColor, IconSparkle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { NextAction } from "@/lib/next-actions";
import "./actions-tab.css";

interface ActionsTabProps {
  actions: NextAction[];
  notes: Record<string, string>;
  savingNote: string | null;
  onDone: (id: string) => void;
  onSkip: (id: string) => void;
  onNoteChange: (id: string, value: string) => void;
  onNoteSave: (id: string) => void;
}

const DEFAULT_NOTE = "Impact: Why this matters for the project.\nOutcome: What \"done\" looks like.";

export function ActionsTab({
  actions,
  notes,
  savingNote,
  onDone,
  onSkip,
  onNoteChange,
  onNoteSave,
}: ActionsTabProps) {
  const [noteOpen, setNoteOpen] = useState<string | null>(null);

  if (actions.length === 0) {
    return (
      <div className="actions-tab__empty">No actions suggested yet.</div>
    );
  }

  return (
    <div className="actions-tab__list">
      {actions.map((action) => (
        <div
          key={action.id}
          className={`actions-tab__action ${
            action.done
              ? "actions-tab__action--done"
              : action.skipped
                ? "actions-tab__action--skipped"
                : "actions-tab__action--default"
          }`}
        >
          <div className="actions-tab__action-row">
            <span style={{ color: sourceColor(action.source || "ai") }}>
              <SourceIcon source={action.source || "ai"} size={14} />
            </span>
            <span
              className={`actions-tab__action-text ${
                action.done ? "actions-tab__action-text--done" : ""
              }`}
            >
              {action.text}
            </span>
            {action.source && action.source !== "ai" && action.source !== "session" && (
              <Badge color={sourceColor(action.source)} small>
                <SourceIcon source={action.source} size={10} /> {action.source}
              </Badge>
            )}
            {!action.done && !action.skipped && (
              <div className="actions-tab__action-buttons">
                <button
                  onClick={() => setNoteOpen(noteOpen === action.id ? null : action.id)}
                  className="actions-tab__action-btn--note"
                >
                  Note
                </button>
                <button onClick={() => onDone(action.id)} className="actions-tab__action-btn--done">
                  Done
                </button>
                <button onClick={() => onSkip(action.id)} className="actions-tab__action-btn--skip">
                  Skip
                </button>
              </div>
            )}
          </div>

          {noteOpen === action.id && (
            <div className="actions-tab__note">
              <textarea
                rows={3}
                value={notes[action.id] ?? DEFAULT_NOTE}
                onChange={(e) => onNoteChange(action.id, e.target.value)}
                className="actions-tab__note-textarea"
              />
              <div className="actions-tab__note-footer">
                <span className="actions-tab__note-hint">
                  <IconSparkle size={10} /> AI-suggested — edit freely
                </span>
                <div className="actions-tab__note-actions">
                  <button
                    onClick={() => onNoteChange(action.id, "")}
                    className="actions-tab__note-clear"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => onNoteSave(action.id)}
                    disabled={savingNote === action.id}
                    className="actions-tab__note-save"
                  >
                    {savingNote === action.id ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

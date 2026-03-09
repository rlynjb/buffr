"use client";

import { useState } from "react";
import { SourceIcon, sourceColor, IconSparkle, IconLink } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { NextAction } from "@/lib/next-actions";
import type { WorkItem, Project } from "@/lib/types";
import "./actions-tab.css";

interface ActionsTabProps {
  actions: NextAction[];
  notes: Record<string, string>;
  savingNote: string | null;
  onDone: (id: string) => void;
  onSkip: (id: string) => void;
  onNoteChange: (id: string, value: string) => void;
  onNoteSave: (id: string) => void;
  workItems: WorkItem[];
  project: Project;
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
  workItems,
  project,
}: ActionsTabProps) {
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const hasDataSource = (project.dataSources || []).length > 0 || !!project.githubRepo;

  return (
    <div>
      {actions.length > 0 && (
        <>
          <p className="actions-tab__desc">
            <span className="actions-tab__desc-icon" style={{ color: "#c084fc" }}><SourceIcon source="ai" size={11} /></span> AI-suggested
            <span className="actions-tab__desc-sep">·</span>
            <span className="actions-tab__desc-icon" style={{ color: "#a78bfa" }}><SourceIcon source="session" size={11} /></span> From last session
          </p>
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
        </>
      )}

      {actions.length === 0 && workItems.length === 0 && (
        <div className="actions-tab__empty">No actions or open items yet.</div>
      )}

      {workItems.length > 0 && (
        <div className="actions-tab__issues">
          <h3 className="actions-tab__issues-heading">Open Issues</h3>
          <div className="actions-tab__issues-list">
            {workItems.slice(0, 15).map((item) => (
              <a
                key={`${item.source}-${item.id}`}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="actions-tab__issue"
              >
                <span style={{ color: sourceColor(item.source) }}>
                  <SourceIcon source={item.source} size={14} />
                </span>
                <span className="actions-tab__issue-title">{item.title}</span>
                <span className="actions-tab__issue-id">{item.id}</span>
                {item.labels?.slice(0, 3).map((l) => (
                  <Badge key={l} color="#666" small>{l}</Badge>
                ))}
                <span className="actions-tab__issue-link">
                  <IconLink size={12} />
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {workItems.length === 0 && hasDataSource && actions.length > 0 && (
        <div className="actions-tab__issues">
          <h3 className="actions-tab__issues-heading">Open Issues</h3>
          <div className="actions-tab__issues-empty">No open items from connected sources.</div>
        </div>
      )}
    </div>
  );
}

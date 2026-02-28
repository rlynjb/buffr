"use client";

import { useState } from "react";
import { SourceIcon, sourceColor } from "@/components/icons";
import { IconSparkle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { NextAction } from "@/lib/next-actions";

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
      <div className="py-8 text-center text-sm text-zinc-600">
        No actions suggested yet.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {actions.map((action) => (
        <div
          key={action.id}
          className={`rounded-lg border transition-all ${
            action.done
              ? "border-emerald-500/20 bg-emerald-500/5 opacity-60"
              : action.skipped
                ? "border-zinc-800/40 opacity-30"
                : "border-zinc-800/40 hover:bg-white/[0.02]"
          }`}
        >
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span style={{ color: sourceColor(action.source || "ai") }}>
              <SourceIcon source={action.source || "ai"} size={14} />
            </span>
            <span
              className={`text-sm flex-1 ${
                action.done ? "line-through text-zinc-500" : "text-zinc-200"
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
              <div className="flex gap-1">
                <button
                  onClick={() => setNoteOpen(noteOpen === action.id ? null : action.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  Note
                </button>
                <button
                  onClick={() => onDone(action.id)}
                  className="px-2 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer"
                >
                  Done
                </button>
                <button
                  onClick={() => onSkip(action.id)}
                  className="px-2 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  Skip
                </button>
              </div>
            )}
          </div>

          {/* Expandable note */}
          {noteOpen === action.id && (
            <div className="px-3 pb-2.5">
              <textarea
                rows={3}
                value={notes[action.id] ?? DEFAULT_NOTE}
                onChange={(e) => onNoteChange(action.id, e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors leading-relaxed"
              />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[10px] text-zinc-600 flex items-center gap-1">
                  <IconSparkle size={10} /> AI-suggested — edit freely
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => onNoteChange(action.id, "")}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => onNoteSave(action.id)}
                    disabled={savingNote === action.id}
                    className="text-[10px] text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-50 cursor-pointer"
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

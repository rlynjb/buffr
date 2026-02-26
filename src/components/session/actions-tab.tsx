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

export function ActionsTab({
  actions,
  notes,
  savingNote,
  onDone,
  onSkip,
  onNoteChange,
  onNoteSave,
}: ActionsTabProps) {
  if (actions.length === 0) {
    return <p className="text-sm text-muted">No actions suggested</p>;
  }

  return (
    <div className="space-y-3">
      {actions.map((action) => (
        <div
          key={action.id}
          className={`rounded-lg border border-border p-3 ${
            action.done
              ? "opacity-50"
              : action.skipped
                ? "opacity-30"
                : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <span className={`text-sm text-foreground ${action.done ? "line-through" : ""}`}>
              {action.source === "ai" && <span className="mr-1" title="AI suggested">&#10024;</span>}
              {action.text}
            </span>
            {!action.done && !action.skipped && (
              <div className="flex gap-2 shrink-0 ml-3">
                <button
                  onClick={() => onDone(action.id)}
                  className="text-xs text-success hover:underline"
                >
                  Done
                </button>
                <button
                  onClick={() => onSkip(action.id)}
                  className="text-xs text-muted hover:underline"
                >
                  Skip
                </button>
              </div>
            )}
          </div>
          <div className="mt-2">
            <textarea
              value={notes[action.id] || ""}
              onChange={(e) => onNoteChange(action.id, e.target.value)}
              placeholder="Add notes..."
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent resize-y"
            />
            <button
              onClick={() => onNoteSave(action.id)}
              disabled={savingNote === action.id}
              className="mt-1 text-xs text-accent hover:underline disabled:opacity-50"
            >
              {savingNote === action.id ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

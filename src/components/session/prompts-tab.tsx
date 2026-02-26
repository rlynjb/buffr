"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { Prompt, PromptResponse } from "@/lib/types";
import { runPrompt, executeToolAction } from "@/lib/api";
import { useProvider } from "@/context/provider-context";

interface PromptsTabProps {
  prompts: Prompt[];
  resolvedBodies: Record<string, string>;
  copiedId: string | null;
  projectId?: string;
  onCopy: (prompt: Prompt) => void;
}

export function PromptsTab({
  prompts,
  resolvedBodies,
  copiedId,
  projectId,
  onCopy,
}: PromptsTabProps) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, PromptResponse>>({});
  const [actionStates, setActionStates] = useState<Record<string, "idle" | "running" | "done" | "error">>({});
  const { providers, selected } = useProvider();

  const hasLLM = providers.length > 0;

  async function handleRun(prompt: Prompt) {
    setRunningId(prompt.id);
    try {
      const result = await runPrompt(prompt.id, projectId, selected);
      setResponses((prev) => ({ ...prev, [prompt.id]: result }));
    } catch (err) {
      console.error("Run prompt failed:", err);
      setResponses((prev) => ({
        ...prev,
        [prompt.id]: { text: `Error: ${err instanceof Error ? err.message : "Failed to run prompt"}` },
      }));
    } finally {
      setRunningId(null);
    }
  }

  async function handleAction(promptId: string, actionIdx: number, tool: string, params: Record<string, unknown>) {
    const key = `${promptId}-${actionIdx}`;
    setActionStates((prev) => ({ ...prev, [key]: "running" }));
    try {
      await executeToolAction(tool, params);
      setActionStates((prev) => ({ ...prev, [key]: "done" }));
    } catch {
      setActionStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  if (prompts.length === 0) {
    return (
      <p className="text-sm text-muted">
        No prompts yet. Add prompts from the{" "}
        <a href="/prompts" className="text-accent hover:underline">Prompt Library</a>{" "}
        to see them here with project context auto-filled.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {prompts.map((prompt) => {
        const response = responses[prompt.id];
        const isRunning = runningId === prompt.id;

        return (
          <div
            key={prompt.id}
            className="rounded-lg border border-border p-3"
          >
            <h4 className="text-sm font-medium text-foreground mb-1.5">
              {prompt.title}
              {prompt.usageCount ? (
                <span className="ml-2 text-xs text-muted">({prompt.usageCount} uses)</span>
              ) : null}
            </h4>
            <pre className="text-xs text-muted font-mono whitespace-pre-wrap mb-2 line-clamp-4">
              {resolvedBodies[prompt.id] || prompt.body}
            </pre>
            {prompt.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {prompt.tags.map((tag) => (
                  <Badge key={tag} variant="default">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => onCopy(prompt)}
                className="text-xs text-accent hover:underline"
              >
                {copiedId === prompt.id ? "Copied!" : "Copy"}
              </button>
              {hasLLM && (
                <button
                  onClick={() => handleRun(prompt)}
                  disabled={isRunning}
                  className="text-xs text-accent hover:underline disabled:opacity-50"
                >
                  {isRunning ? "Running..." : "Run"}
                </button>
              )}
            </div>

            {/* LLM Response */}
            {response && (
              <div className="mt-3 rounded-md bg-surface p-3 border border-border">
                <p className="text-xs text-muted mb-1">AI Response:</p>
                <div className="text-sm text-foreground whitespace-pre-wrap">
                  {response.text}
                </div>
                {response.suggestedActions && response.suggestedActions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {response.suggestedActions.map((action, idx) => {
                      const key = `${prompt.id}-${idx}`;
                      const state = actionStates[key] || "idle";
                      return (
                        <button
                          key={key}
                          onClick={() => handleAction(prompt.id, idx, action.tool, action.params)}
                          disabled={state === "running" || state === "done"}
                          className="text-xs px-2 py-1 rounded border border-border text-accent hover:bg-surface disabled:opacity-50"
                        >
                          {state === "running" && "Running..."}
                          {state === "done" && `\u2713 ${action.label}`}
                          {state === "error" && `\u2717 ${action.label}`}
                          {state === "idle" && action.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

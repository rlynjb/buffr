import { Badge } from "@/components/ui/badge";
import type { Prompt } from "@/lib/types";

interface PromptsTabProps {
  prompts: Prompt[];
  resolvedBodies: Record<string, string>;
  copiedId: string | null;
  onCopy: (prompt: Prompt) => void;
}

export function PromptsTab({
  prompts,
  resolvedBodies,
  copiedId,
  onCopy,
}: PromptsTabProps) {
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
      {prompts.map((prompt) => (
        <div
          key={prompt.id}
          className="rounded-lg border border-border p-3"
        >
          <h4 className="text-sm font-medium text-foreground mb-1.5">
            {prompt.title}
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
          <button
            onClick={() => onCopy(prompt)}
            className="text-xs text-accent hover:underline"
          >
            {copiedId === prompt.id ? "Copied!" : "Copy"}
          </button>
        </div>
      ))}
    </div>
  );
}

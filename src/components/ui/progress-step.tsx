"use client";

export type StepStatus = "pending" | "running" | "success" | "failed";

interface ProgressStepProps {
  name: string;
  status: StepStatus;
  result?: string;
  error?: string;
}

const statusIcons: Record<StepStatus, React.ReactNode> = {
  pending: (
    <span className="h-5 w-5 rounded-full border-2 border-border" />
  ),
  running: (
    <span className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
  ),
  success: (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white text-xs">
      &#10003;
    </span>
  ),
  failed: (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-error text-white text-xs">
      &#10007;
    </span>
  ),
};

export function ProgressStep({ name, status, result, error }: ProgressStepProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 shrink-0">{statusIcons[status]}</div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm ${status === "running" ? "text-accent font-medium" : status === "failed" ? "text-error" : "text-foreground"}`}
        >
          {name}
        </p>
        {result && (
          <p className="text-xs text-muted font-mono mt-0.5 truncate">
            {result}
          </p>
        )}
        {error && (
          <p className="text-xs text-error mt-0.5">{error}</p>
        )}
      </div>
    </div>
  );
}

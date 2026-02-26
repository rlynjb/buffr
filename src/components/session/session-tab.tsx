import { Badge } from "@/components/ui/badge";
import type { Session } from "@/lib/types";

interface SessionTabProps {
  lastSession: Session | null;
}

export function SessionTab({ lastSession }: SessionTabProps) {
  if (!lastSession) {
    return (
      <div className="text-sm text-muted space-y-1">
        <p>This is where your last work session will appear. It tracks what you worked on, what changed, what to do next, and any blockers.</p>
        <p>Click &quot;End Session&quot; below when you&apos;re done working to log your progress.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      {lastSession.goal && (
        <div className="flex items-center gap-2">
          <span className="text-muted">Goal: </span>
          <span className="text-foreground">{lastSession.goal}</span>
          {lastSession.detectedIntent && (
            <Badge variant="default">{lastSession.detectedIntent}</Badge>
          )}
        </div>
      )}
      {lastSession.nextStep && (
        <div>
          <span className="text-muted">Next: </span>
          <span className="text-foreground">{lastSession.nextStep}</span>
        </div>
      )}
      {lastSession.blockers && (
        <div>
          <span className="text-error">Blocked: </span>
          <span className="text-foreground">{lastSession.blockers}</span>
        </div>
      )}
      {lastSession.whatChanged.length > 0 && (
        <div>
          <span className="text-muted block mb-1">What changed:</span>
          <ul className="list-disc list-inside text-foreground space-y-0.5">
            {lastSession.whatChanged.map((item, i) => (
              <li key={i} className="text-sm">{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-xs text-muted">
        {new Date(lastSession.createdAt).toLocaleDateString()} at{" "}
        {new Date(lastSession.createdAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

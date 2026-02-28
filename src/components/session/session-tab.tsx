import "./session-tab.css";
import type { Session } from "@/lib/types";

interface SessionTabProps {
  lastSession: Session | null;
}

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function SessionTab({ lastSession }: SessionTabProps) {
  if (!lastSession) {
    return (
      <div className="session-tab__empty">
        No sessions yet. Start your first session!
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {lastSession.goal && (
        <div>
          <div className="session-tab__label">Goal</div>
          <div className="session-tab__value">{lastSession.goal}</div>
        </div>
      )}
      {lastSession.whatChanged.length > 0 && (
        <div>
          <div className="session-tab__label--changes">What Changed</div>
          <div className="space-y-1">
            {lastSession.whatChanged.map((w, i) => (
              <div key={i} className="session-tab__change">
                <span className="session-tab__change-dot">·</span>
                {w}
              </div>
            ))}
          </div>
        </div>
      )}
      {lastSession.nextStep && (
        <div>
          <div className="session-tab__label">Next Step</div>
          <div className="session-tab__value">{lastSession.nextStep}</div>
        </div>
      )}
      {lastSession.blockers && (
        <div>
          <div className="session-tab__label--blocker">Blockers</div>
          <div className="session-tab__value--blocker">{lastSession.blockers}</div>
        </div>
      )}
      <div className="session-tab__timestamp">{timeAgo(lastSession.createdAt)}</div>
    </div>
  );
}

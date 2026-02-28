import "./session-tab.css";
import type { Session } from "@/lib/types";
import { timeAgo } from "@/lib/format";

interface SessionTabProps {
  lastSession: Session | null;
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

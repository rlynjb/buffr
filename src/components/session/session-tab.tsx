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
      <div className="py-8 text-center text-sm text-zinc-600">
        No sessions yet. Start your first session!
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {lastSession.goal && (
        <div>
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">
            Goal
          </div>
          <div className="text-sm text-zinc-200">{lastSession.goal}</div>
        </div>
      )}
      {lastSession.whatChanged.length > 0 && (
        <div>
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5">
            What Changed
          </div>
          <div className="space-y-1">
            {lastSession.whatChanged.map((w, i) => (
              <div key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                <span className="text-zinc-600 mt-0.5">·</span>
                {w}
              </div>
            ))}
          </div>
        </div>
      )}
      {lastSession.nextStep && (
        <div>
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">
            Next Step
          </div>
          <div className="text-sm text-zinc-200">{lastSession.nextStep}</div>
        </div>
      )}
      {lastSession.blockers && (
        <div>
          <div className="text-[11px] text-red-400/60 uppercase tracking-wider font-semibold mb-1">
            Blockers
          </div>
          <div className="text-sm text-red-300/80">{lastSession.blockers}</div>
        </div>
      )}
      <div className="text-[11px] text-zinc-600">{timeAgo(lastSession.createdAt)}</div>
    </div>
  );
}

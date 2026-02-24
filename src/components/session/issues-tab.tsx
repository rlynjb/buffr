import { Badge } from "@/components/ui/badge";
import type { GitHubIssue } from "@/lib/types";

interface IssuesTabProps {
  issues: GitHubIssue[];
  hasRepo: boolean;
}

export function IssuesTab({ issues, hasRepo }: IssuesTabProps) {
  if (issues.length === 0) {
    return (
      <div className="text-sm text-muted space-y-1">
        {hasRepo ? (
          <p>No open issues on this repository. When issues are created on GitHub, they&apos;ll appear here and feed into your Next Actions.</p>
        ) : (
          <p>This is where open GitHub issues will appear. Connect a GitHub repository to pull in issues, which also feed into your Next Actions as suggested tasks.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {issues.slice(0, 5).map((issue) => (
        <div key={issue.number} className="text-sm">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:text-accent hover:underline"
          >
            <span className="text-muted font-mono mr-1.5">
              #{issue.number}
            </span>
            {issue.title}
          </a>
          {issue.labels.length > 0 && (
            <div className="flex gap-1 mt-1">
              {issue.labels.slice(0, 3).map((label) => (
                <Badge key={label} variant="default">
                  {label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

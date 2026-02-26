import { Badge } from "@/components/ui/badge";
import type { WorkItem } from "@/lib/types";

interface IssuesTabProps {
  items: WorkItem[];
  hasDataSource: boolean;
}

export function IssuesTab({ items, hasDataSource }: IssuesTabProps) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted space-y-1">
        {hasDataSource ? (
          <p>No open items found. When issues or tasks are created in your connected sources, they&apos;ll appear here and feed into your Next Actions.</p>
        ) : (
          <p>This is where open items will appear. Connect a data source like GitHub, Notion, or Jira to pull in issues and tasks, which also feed into your Next Actions as suggested tasks.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.slice(0, 5).map((item) => (
        <div key={`${item.source}-${item.id}`} className="text-sm">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:text-accent hover:underline"
          >
            <span className="text-muted font-mono mr-1.5">
              #{item.id}
            </span>
            {item.title}
          </a>
          <div className="flex gap-1 mt-1">
            <Badge variant="default">{item.source}</Badge>
            {item.labels && item.labels.slice(0, 3).map((label) => (
              <Badge key={label} variant="default">
                {label}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { IconCheck, IconX } from "@/components/icons";
import "./review-banner.css";

export interface ReviewableChange {
  path: string;
  oldContent: string;
  newContent: string;
}

interface ReviewBannerProps {
  changes: ReviewableChange[];
  decisions: Record<string, "accepted" | "rejected">;
  onApply: () => void;
  applying: boolean;
}

export function ReviewBanner({ changes, decisions, onApply, applying }: ReviewBannerProps) {
  const reviewed = changes.filter((c) => c.path in decisions).length;
  const accepted = Object.values(decisions).filter((d) => d === "accepted").length;
  const rejected = Object.values(decisions).filter((d) => d === "rejected").length;
  const allReviewed = reviewed === changes.length;

  return (
    <div className="review-banner">
      <div className="review-banner__info">
        <span className="review-banner__title">
          Re-scan found changes in {changes.length} reviewable file{changes.length !== 1 ? "s" : ""}
        </span>
        <span className="review-banner__stats">
          {reviewed}/{changes.length} reviewed
          {accepted > 0 && (
            <>
              {" · "}
              <IconCheck size={10} /> {accepted} accepted
            </>
          )}
          {rejected > 0 && (
            <>
              {" · "}
              <IconX size={10} /> {rejected} rejected
            </>
          )}
        </span>
      </div>
      {allReviewed && (
        <Button size="sm" variant="primary" onClick={onApply} disabled={applying}>
          {applying ? "Applying..." : "Apply & Push"}
        </Button>
      )}
    </div>
  );
}

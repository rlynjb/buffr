"use client";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
}

export function Card({
  children,
  className = "",
  onClick,
  hover = false,
}: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-border bg-card p-5 ${hover ? "cursor-pointer transition-colors hover:bg-card-hover hover:border-muted/30" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

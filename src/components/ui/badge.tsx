"use client";

import "./badge.css";

interface BadgeProps {
  children: React.ReactNode;
  color?: string;
  variant?: string;
  small?: boolean;
  className?: string;
}

export function Badge({
  children,
  color,
  small,
  className = "",
}: BadgeProps) {
  if (color) {
    return (
      <span
        className={`badge badge--colored ${small ? "badge--small" : ""} ${className}`}
        style={{
          "--badge-color": color,
          "--badge-bg": `${color}18`,
          "--badge-border": `${color}30`,
        } as React.CSSProperties}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className={`badge badge--default ${small ? "badge--small" : ""} ${className}`}
    >
      {children}
    </span>
  );
}

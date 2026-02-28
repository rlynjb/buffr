"use client";

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
        className={`inline-flex items-center gap-1 ${small ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]"} rounded font-semibold uppercase tracking-wider border ${className}`}
        style={{
          color,
          backgroundColor: `${color}18`,
          borderColor: `${color}30`,
        }}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 ${small ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]"} rounded font-semibold uppercase tracking-wider bg-zinc-800/50 text-zinc-400 border border-zinc-700/50 ${className}`}
    >
      {children}
    </span>
  );
}

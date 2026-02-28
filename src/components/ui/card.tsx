"use client";

import "./card.css";

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
      className={`card ${hover ? "card--hoverable" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

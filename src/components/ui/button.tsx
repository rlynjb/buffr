"use client";

import { type ButtonHTMLAttributes, forwardRef } from "react";
import "./button.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "button--primary",
  secondary: "button--secondary",
  ghost: "button--ghost",
  danger: "button--danger",
};

const sizeClasses: Record<Size, string> = {
  sm: "button--sm",
  md: "button--md",
  lg: "button--lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`button ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {loading && <span className="button__spinner" />}
        {children}
      </button>
    );
  }
);

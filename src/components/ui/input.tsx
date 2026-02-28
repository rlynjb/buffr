"use client";

import { type InputHTMLAttributes, forwardRef } from "react";
import "./input.css";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ label, error, mono, className = "", id, ...props }, ref) {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="input">
        {label && (
          <label htmlFor={inputId} className="input__label">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`input__field ${mono ? "input__field--mono" : ""} ${error ? "input__field--error" : ""} ${className}`}
          {...props}
        />
        {error && <p className="input__error">{error}</p>}
      </div>
    );
  }
);

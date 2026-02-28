"use client";

import { type TextareaHTMLAttributes, forwardRef } from "react";
import "./textarea.css";

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  mono?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ label, error, mono, className = "", id, ...props }, ref) {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="textarea">
        {label && (
          <label htmlFor={inputId} className="textarea__label">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={`textarea__field ${mono ? "textarea__field--mono" : ""} ${error ? "textarea__field--error" : ""} ${className}`}
          {...props}
        />
        {error && <p className="textarea__error">{error}</p>}
      </div>
    );
  }
);

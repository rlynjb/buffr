"use client";

import "./toggle.css";

interface ToggleProps {
  options: [string, string];
  value: string;
  onChange: (value: string) => void;
}

export function Toggle({ options, value, onChange }: ToggleProps) {
  return (
    <div className="toggle">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`toggle__option ${
            value === opt ? "toggle__option--active" : "toggle__option--inactive"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

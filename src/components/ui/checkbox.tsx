"use client";

import "./checkbox.css";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: CheckboxProps) {
  return (
    <label
      className={`checkbox ${disabled ? "checkbox--disabled" : "checkbox--enabled"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="checkbox__input"
      />
      <div className="flex-1 min-w-0">
        <span className="checkbox__text">{label}</span>
        {description && (
          <p className="checkbox__description">{description}</p>
        )}
      </div>
    </label>
  );
}

"use client";

interface ToggleProps {
  options: [string, string];
  value: string;
  onChange: (value: string) => void;
}

export function Toggle({ options, value, onChange }: ToggleProps) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-background p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            value === opt
              ? "bg-card text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

"use client";

interface ToggleProps {
  options: [string, string];
  value: string;
  onChange: (value: string) => void;
}

export function Toggle({ options, value, onChange }: ToggleProps) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-700/50 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-4 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
            value === opt
              ? "bg-zinc-700/50 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

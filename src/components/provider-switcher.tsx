"use client";

import { useProvider } from "@/context/provider-context";

export function ProviderSwitcher() {
  const { providers, selected, setSelected, loading, error } = useProvider();

  if (loading) {
    return (
      <div className="h-8 w-32 animate-pulse rounded-lg bg-card" />
    );
  }

  if (error || providers.length === 0) {
    return (
      <span className="text-xs text-muted font-mono">
        No LLM configured
      </span>
    );
  }

  if (providers.length === 1) {
    const p = providers[0];
    return (
      <span className="text-xs text-muted font-mono">
        {p.label} &mdash; {p.model}
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => setSelected(e.target.value)}
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-mono text-foreground focus:border-accent focus:outline-none cursor-pointer"
    >
      {providers.map((p) => (
        <option key={p.name} value={p.name}>
          {p.label} &mdash; {p.model}
        </option>
      ))}
    </select>
  );
}

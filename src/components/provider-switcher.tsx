"use client";

import { useProvider } from "@/context/provider-context";

export function ProviderSwitcher() {
  const { providers, selected, setSelected, loading, error } = useProvider();

  if (loading) {
    return (
      <div className="h-8 w-32 animate-pulse rounded-lg bg-zinc-800" />
    );
  }

  if (error || providers.length === 0) {
    return (
      <span className="text-xs text-zinc-500 font-mono">
        No LLM configured
      </span>
    );
  }

  if (providers.length === 1) {
    const p = providers[0];
    return (
      <span className="text-xs text-zinc-500 font-mono">
        {p.label} &mdash; {p.model}
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => setSelected(e.target.value)}
      className="bg-zinc-800/80 border border-zinc-700/50 rounded-lg px-2 py-1.5 text-xs text-zinc-300 font-mono focus:outline-none focus:border-purple-500/40 cursor-pointer"
    >
      {providers.map((p) => (
        <option key={p.name} value={p.name}>
          {p.label} &mdash; {p.model}
        </option>
      ))}
    </select>
  );
}

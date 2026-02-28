"use client";

import { useProvider } from "@/context/provider-context";
import "./provider-switcher.css";

export function ProviderSwitcher() {
  const { providers, selected, setSelected, loading, error } = useProvider();

  if (loading) {
    return <div className="provider-switcher__skeleton" />;
  }

  if (error || providers.length === 0) {
    return (
      <span className="provider-switcher__label">No LLM configured</span>
    );
  }

  if (providers.length === 1) {
    const p = providers[0];
    return (
      <span className="provider-switcher__label">
        {p.label} &mdash; {p.model}
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => setSelected(e.target.value)}
      className="provider-switcher__select"
    >
      {providers.map((p) => (
        <option key={p.name} value={p.name}>
          {p.label} &mdash; {p.model}
        </option>
      ))}
    </select>
  );
}

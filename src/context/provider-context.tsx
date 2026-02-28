"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { LLMProvider } from "@/lib/types";
import { getProviders } from "@/lib/api";

interface ProviderContextType {
  providers: LLMProvider[];
  selected: string;
  setSelected: (name: string) => void;
  loading: boolean;
  error: string | null;
}

const ProviderContext = createContext<ProviderContextType>({
  providers: [],
  selected: "",
  setSelected: () => {},
  loading: true,
  error: null,
});

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [selected, setSelectedState] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getProviders();
        if (cancelled) return;
        setProviders(data.providers);

        // Restore from localStorage or use default
        const stored = localStorage.getItem("buffr-provider");
        const valid = data.providers.find((p) => p.name === stored);
        if (valid) {
          setSelectedState(valid.name);
        } else if (data.providers.length > 0) {
          const def = data.providers.find(
            (p) => p.name === data.defaultProvider
          );
          setSelectedState(def ? def.name : data.providers[0].name);
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load providers:", err);
        setError("Could not load LLM providers. Check your .env configuration.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function setSelected(name: string) {
    setSelectedState(name);
    localStorage.setItem("buffr-provider", name);
  }

  return (
    <ProviderContext.Provider
      value={{ providers, selected, setSelected, loading, error }}
    >
      {children}
    </ProviderContext.Provider>
  );
}

export function useProvider() {
  return useContext(ProviderContext);
}

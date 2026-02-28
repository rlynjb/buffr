"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProviderSwitcher } from "./provider-switcher";
import { IconCmd } from "./icons";

const pageLabels: Record<string, string> = {
  "/prompts": "Prompt Library",
  "/tools": "Tools",
};

export function Nav() {
  const pathname = usePathname();

  const isProject = pathname.startsWith("/project/");
  const label = isProject ? "Resume Card" : pageLabels[pathname] || null;

  return (
    <nav className="sticky top-0 z-40 flex items-center justify-between px-4 sm:px-6 py-3 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
            <span className="text-[10px] font-black text-white font-mono">b</span>
          </div>
          <span className="text-sm font-semibold text-zinc-200 hidden sm:inline font-mono">
            buffr
          </span>
        </Link>
        {label && (
          <span className="px-2 py-0.5 rounded bg-zinc-800/60 text-zinc-400 text-xs capitalize">
            {label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
            );
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
        >
          <IconCmd size={14} />
          <span className="hidden sm:inline">Cmd+K</span>
        </button>
        <ProviderSwitcher />
      </div>
    </nav>
  );
}

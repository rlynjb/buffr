"use client";

import Link from "next/link";
import { ProviderSwitcher } from "./provider-switcher";

export function Nav() {
  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link
          href="/"
          className="text-lg font-bold font-mono tracking-tight text-foreground hover:text-accent transition-colors"
        >
          buffr
        </Link>
        <div className="flex items-center gap-4">
          <ProviderSwitcher />
          <span className="text-xs text-muted font-mono hidden sm:inline">
            &#8984;K
          </span>
        </div>
      </div>
    </nav>
  );
}

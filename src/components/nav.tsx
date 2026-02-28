"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProviderSwitcher } from "./provider-switcher";
import { IconCmd } from "./icons";
import "./nav.css";

const pageLabels: Record<string, string> = {
  "/prompts": "Prompt Library",
  "/tools": "Tools",
};

export function Nav() {
  const pathname = usePathname();

  const isProject = pathname.startsWith("/project/");
  const label = isProject ? "Resume Card" : pageLabels[pathname] || null;

  return (
    <nav className="nav">
      <div className="nav__left">
        <Link href="/" className="nav__logo">
          <div className="nav__logo-icon">
            <span className="nav__logo-icon-text">b</span>
          </div>
          <span className="nav__logo-text">buffr</span>
        </Link>
        {label && (
          <span className="nav__breadcrumb">{label}</span>
        )}
      </div>
      <div className="nav__right">
        <button
          onClick={() => {
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
            );
          }}
          className="nav__cmd-button"
        >
          <IconCmd size={14} />
          <span className="nav__cmd-label">Cmd+K</span>
        </button>
        <ProviderSwitcher />
      </div>
    </nav>
  );
}

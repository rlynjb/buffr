"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/auth-context";
import { ProviderSwitcher } from "./provider-switcher";
import "./nav.css";

const pageLabels: Record<string, string> = {};

export function Nav() {
  const pathname = usePathname();
  const { logout } = useAuth();

  const label = pageLabels[pathname] || null;

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
        <ProviderSwitcher />
        <button onClick={logout} className="nav__signout">
          Sign out
        </button>
      </div>
    </nav>
  );
}

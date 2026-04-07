"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  IconSearch,
  IconFolder,
  IconBack,
  IconCheck,
} from "@/components/icons";
import "./command-palette.css";

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = [
    {
      id: "load-existing",
      label: "Load Existing",
      description: "Import a GitHub repo",
      icon: <IconFolder size={14} />,
      action: () => {
        setOpen(false);
        router.push("/");
        setTimeout(() => window.dispatchEvent(new CustomEvent("buffr:open-import")), 100);
      },
    },
    {
      id: "end-session",
      label: "End Session",
      description: "Save progress and close session",
      icon: <IconCheck size={14} />,
      action: () => {
        setOpen(false);
      },
    },
    {
      id: "dashboard",
      label: "Dashboard",
      description: "View all projects",
      icon: <IconBack size={14} />,
      action: () => {
        setOpen(false);
        router.push("/");
      },
    },
  ];

  const filtered = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.description.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelectedIndex(0);
        return;
      }

      if (!open) return;

      if (e.key === "Escape") {
        setOpen(false);
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }

      if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        filtered[selectedIndex].action();
        return;
      }
    },
    [open, filtered, selectedIndex]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div className="command-palette" onClick={() => setOpen(false)}>
      <div className="command-palette__backdrop" />
      <div
        className="command-palette__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette__search">
          <IconSearch size={16} className="command-palette__search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands..."
            className="command-palette__search-input"
          />
          <kbd className="command-palette__search-kbd">ESC</kbd>
        </div>
        <div className="command-palette__results">
          {filtered.length === 0 ? (
            <div className="command-palette__empty">No results</div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={cmd.action}
                className={`command-palette__item ${
                  i === selectedIndex ? "command-palette__item--selected" : ""
                }`}
              >
                <span className="command-palette__item-icon">
                  {cmd.icon}
                </span>
                <div className="command-palette__item-content">
                  <div className="command-palette__item-label">{cmd.label}</div>
                  <div className="command-palette__item-description">
                    {cmd.description}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

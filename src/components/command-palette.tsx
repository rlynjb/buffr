"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Command {
  id: string;
  label: string;
  description: string;
  action: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const commands: Command[] = [
    {
      id: "new-project",
      label: "New Project",
      description: "Start the project creation wizard",
      action: () => {
        setOpen(false);
        router.push("/new");
      },
    },
    {
      id: "load-project",
      label: "Load Existing Project",
      description: "Connect an existing GitHub repository",
      action: () => {
        setOpen(false);
        router.push("/load");
      },
    },
    {
      id: "dashboard",
      label: "Dashboard",
      description: "Go to the project dashboard",
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
      // Open palette with Cmd+K or Ctrl+K
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
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) setOpen(false);
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
        <div className="border-b border-border p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted/60 focus:outline-none"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="p-3 text-sm text-muted text-center">
              No commands found
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={cmd.action}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                  i === selectedIndex
                    ? "bg-accent/10 text-accent"
                    : "text-foreground hover:bg-card-hover"
                }`}
              >
                <span className="block text-sm font-medium">
                  {cmd.label}
                </span>
                <span className="block text-xs text-muted">
                  {cmd.description}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t border-border px-3 py-2 flex items-center gap-4 text-xs text-muted">
          <span>
            <kbd className="rounded bg-background px-1.5 py-0.5 font-mono">
              &#8593;&#8595;
            </kbd>{" "}
            Navigate
          </span>
          <span>
            <kbd className="rounded bg-background px-1.5 py-0.5 font-mono">
              &#8629;
            </kbd>{" "}
            Select
          </span>
          <span>
            <kbd className="rounded bg-background px-1.5 py-0.5 font-mono">
              Esc
            </kbd>{" "}
            Close
          </span>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Prompt } from "@/lib/types";
import { listPrompts } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  IconSearch,
  IconFolder,
  IconBack,
  IconPrompt,
  IconTool,
  IconSparkle,
  IconCheck,
} from "@/components/icons";

function isReferencePrompt(body: string): boolean {
  return !body.includes("{{");
}

interface Command {
  id: string;
  label: string;
  description: string;
  kind: "action" | "prompt";
  icon: React.ReactNode;
  action: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [prompts, setPrompts] = useState<Prompt[]>([]);

  useEffect(() => {
    if (!open) return;
    listPrompts().then(setPrompts).catch(() => setPrompts([]));
  }, [open]);

  const commands: Command[] = [
    {
      id: "load-existing",
      label: "Load Existing",
      description: "Import a GitHub repo",
      kind: "action",
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
      kind: "action",
      icon: <IconCheck size={14} />,
      action: () => {
        setOpen(false);
      },
    },
    {
      id: "dashboard",
      label: "Dashboard",
      description: "View all projects",
      kind: "action",
      icon: <IconBack size={14} />,
      action: () => {
        setOpen(false);
        router.push("/");
      },
    },
    {
      id: "tools",
      label: "Tools & Integrations",
      description: "Manage connected services",
      kind: "action",
      icon: <IconTool size={14} />,
      action: () => {
        setOpen(false);
        router.push("/tools");
      },
    },
    {
      id: "prompts-lib",
      label: "Prompt Library",
      description: "Manage and create prompts",
      kind: "action",
      icon: <IconPrompt size={14} />,
      action: () => {
        setOpen(false);
        router.push("/prompts");
      },
    },
    ...[...prompts]
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      .map((p) => {
        const isRef = isReferencePrompt(p.body);
        return {
          id: `prompt-${p.id}`,
          label: p.title,
          description: isRef
            ? p.tags.join(", ") || "Reference prompt"
            : p.tags.join(", ") || "Prompt template",
          kind: "prompt" as const,
          icon: <IconSparkle size={14} />,
          action: () => {
            navigator.clipboard.writeText(p.body);
            setOpen(false);
          },
        };
      }),
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-2xl overflow-hidden animate-slideDown"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <IconSearch size={16} className="text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, prompts..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none"
          />
          <kbd className="shrink-0 px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-500 border border-zinc-700/50 font-mono">
            ESC
          </kbd>
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-zinc-500">
              No results
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={cmd.action}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors group cursor-pointer ${
                  i === selectedIndex
                    ? "bg-white/[0.04]"
                    : "hover:bg-white/[0.04]"
                }`}
              >
                <span
                  className={`shrink-0 ${
                    cmd.kind === "prompt"
                      ? "text-purple-400"
                      : "text-zinc-500"
                  } group-hover:text-zinc-300 transition-colors`}
                >
                  {cmd.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200">{cmd.label}</div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {cmd.description}
                  </div>
                </div>
                {cmd.kind === "prompt" && (
                  <span className="flex gap-1 shrink-0">
                    <Badge color="#c084fc" small>Run</Badge>
                    <Badge small>Copy</Badge>
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

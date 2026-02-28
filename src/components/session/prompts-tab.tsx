"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { IconChevron, IconCopy, IconPlay, IconLoader, IconSparkle, IconCheck } from "@/components/icons";
import type { Prompt, PromptResponse } from "@/lib/types";
import { runPrompt, executeToolAction } from "@/lib/api";
import { useProvider } from "@/context/provider-context";

interface PromptsTabProps {
  prompts: Prompt[];
  resolvedBodies: Record<string, string>;
  copiedId: string | null;
  projectId?: string;
  onCopy: (prompt: Prompt) => void;
}

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "setup", label: "Setup & Standards" },
  { key: "dev", label: "Active Dev" },
  { key: "session", label: "Session" },
  { key: "quality", label: "Quality & Review" },
  { key: "reference", label: "Reference" },
] as const;

type Category = typeof CATEGORIES[number]["key"];

const TAG_TO_CATEGORY: Record<string, Category> = {
  setup: "setup", standards: "setup", architecture: "setup", deploy: "setup", changelog: "setup", docs: "setup",
  dev: "dev", development: "dev", diagram: "dev", triage: "dev", refactor: "dev", planning: "dev", github: "dev", workflow: "dev", "code-quality": "dev", visual: "dev",
  session: "session", kickoff: "session", summary: "session", progress: "session", context: "session", reporting: "session",
  quality: "quality", review: "quality", checklist: "quality", pr: "quality", dependency: "quality", qa: "quality", maintenance: "quality",
  reference: "reference", template: "reference", prompt: "reference",
};

function isReferencePrompt(body: string): boolean {
  return !body.includes("{{");
}

function hasToolTokens(body: string): boolean {
  return /\{\{tool:\w+/.test(body);
}

function hasAnyTokens(body: string): boolean {
  return /\{\{/.test(body);
}

function getPromptCategory(prompt: Prompt): Category {
  if (isReferencePrompt(prompt.body)) return "reference";
  for (const tag of prompt.tags) {
    const cat = TAG_TO_CATEGORY[tag.toLowerCase()];
    if (cat) return cat;
  }
  return "dev";
}

function renderBody(body: string) {
  return body.split(/({{.*?}})/).map((part, i) =>
    part.startsWith("{{tool:") ? (
      <span key={i} className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[11px] font-mono">
        {part}
      </span>
    ) : part.startsWith("{{") ? (
      <span key={i} className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[11px] font-mono">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function useTypingEffect(text: string, speed: number = 8) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useState(() => {
    let i = 0;
    setDisplayed("");
    setDone(false);
    const interval = setInterval(() => {
      i += speed;
      if (i >= text.length) {
        setDisplayed(text);
        setDone(true);
        clearInterval(interval);
      } else {
        setDisplayed(text.slice(0, i));
      }
    }, 16);
    return () => clearInterval(interval);
  });

  return { displayed: done ? text : displayed, done };
}

function PromptResponseView({
  response,
  promptId,
  onCopyForClaudeCode,
}: {
  response: PromptResponse;
  promptId: string;
  onCopyForClaudeCode: () => void;
}) {
  const { displayed, done } = useTypingEffect(response.text, 8);
  const [actionStates, setActionStates] = useState<Record<string, "idle" | "running" | "success" | "error">>({});
  const [copied, setCopied] = useState(false);

  async function handleAction(idx: number, tool: string, params: Record<string, unknown>) {
    const key = `${promptId}-${idx}`;
    setActionStates((prev) => ({ ...prev, [key]: "running" }));
    try {
      await executeToolAction(tool, params);
      setActionStates((prev) => ({ ...prev, [key]: "success" }));
    } catch {
      setActionStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  function handleCopyRefine() {
    onCopyForClaudeCode();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="ml-6 rounded-xl border border-purple-500/20 bg-purple-500/[0.03] overflow-hidden">
      <div className="px-4 py-3">
        <div className="text-[11px] text-purple-400/60 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
          <IconSparkle size={10} /> AI Response
        </div>
        <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {displayed.split(/(\*\*.*?\*\*)/).map((p, i) =>
            p.startsWith("**") && p.endsWith("**") ? (
              <strong key={i} className="text-zinc-100">{p.slice(2, -2)}</strong>
            ) : p.startsWith("##") ? (
              <span key={i} className="text-zinc-100 font-semibold">{p.replace(/^##\s*/, "")}</span>
            ) : (
              <span key={i}>{p}</span>
            )
          )}
          {!done && (
            <span className="inline-block w-0.5 h-4 bg-purple-400 ml-0.5 animate-pulse align-text-bottom" />
          )}
        </div>
      </div>

      {done && (response.suggestedActions?.length || response.artifact) && (
        <div className="border-t border-purple-500/10 px-4 py-3 space-y-3">
          {response.suggestedActions && response.suggestedActions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Apply</div>
              {response.suggestedActions.map((action, idx) => {
                const key = `${promptId}-${idx}`;
                const st = actionStates[key] || "idle";
                return (
                  <button
                    key={idx}
                    onClick={() => handleAction(idx, action.tool, action.params)}
                    disabled={st !== "idle"}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all cursor-pointer ${
                      st === "idle"
                        ? "bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/50"
                        : st === "running"
                          ? "bg-zinc-800/30 text-zinc-400 border border-zinc-700/30"
                          : st === "success"
                            ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                            : "bg-red-500/10 text-red-300 border border-red-500/20"
                    }`}
                  >
                    <span className="text-purple-400">
                      <IconSparkle size={14} />
                    </span>
                    <span className="flex-1 truncate">{action.label}</span>
                    {st === "running" && <IconLoader size={14} />}
                    {st === "success" && <span className="text-emerald-400"><IconCheck size={14} /></span>}
                  </button>
                );
              })}
            </div>
          )}

          {response.artifact && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">Refine with local context</div>
              <button
                onClick={handleCopyRefine}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all border cursor-pointer ${
                  copied
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                    : "bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border-zinc-700/50"
                }`}
              >
                <span className="text-blue-400">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
                <span className="flex-1">{copied ? "Copied to clipboard" : "Copy response + context for Claude Code"}</span>
              </button>
              <p className="text-[11px] text-zinc-600 px-1">
                Copies the AI output with your project context. Paste into Claude Code to refine with your local codebase.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PromptsTab({
  prompts,
  resolvedBodies,
  copiedId,
  projectId,
  onCopy,
}: PromptsTabProps) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, PromptResponse>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const { providers, selected } = useProvider();

  const hasLLM = providers.length > 0;

  const categoryCounts: Record<Category, number> = { all: prompts.length, setup: 0, dev: 0, session: 0, quality: 0, reference: 0 };
  for (const p of prompts) {
    const cat = getPromptCategory(p);
    categoryCounts[cat]++;
  }

  const filtered = activeCategory === "all"
    ? prompts
    : prompts.filter((p) => getPromptCategory(p) === activeCategory);

  async function handleRun(prompt: Prompt, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedId(prompt.id);
    setRunningId(prompt.id);
    try {
      const result = await runPrompt(prompt.id, projectId, selected);
      setResponses((prev) => ({ ...prev, [prompt.id]: result }));
    } catch (err) {
      console.error("Run prompt failed:", err);
      setResponses((prev) => ({
        ...prev,
        [prompt.id]: { text: `Error: ${err instanceof Error ? err.message : "Failed to run prompt"}` },
      }));
    } finally {
      setRunningId(null);
    }
  }

  async function handleCopyForClaudeCode(prompt: Prompt, response: PromptResponse) {
    const context = [
      `# Prompt: ${prompt.title}`,
      "",
      "## AI Response (from buffr)",
      response.text,
      "",
      "## Project Context",
      resolvedBodies[prompt.id] || prompt.body,
      "",
      "---",
      "Refine this output using your awareness of the local codebase.",
    ].join("\n");
    await navigator.clipboard.writeText(context);
  }

  if (prompts.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-zinc-600">
        No prompts yet. Add prompts from the{" "}
        <a href="/prompts" className="text-purple-400 hover:underline">Prompt Library</a>{" "}
        to see them here with project context auto-filled.
      </div>
    );
  }

  return (
    <div>
      {/* Category filter */}
      <div className="flex items-center gap-1.5 pb-3 mb-3 border-b border-zinc-800/50">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
              activeCategory === cat.key
                ? "bg-zinc-700/50 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            {cat.label}
          </button>
        ))}
        <span className="text-[10px] text-zinc-600 ml-auto">
          {filtered.length} prompt{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Accordion list */}
      <div className="space-y-1.5">
        {filtered.map((prompt) => {
          const isExpanded = expandedId === prompt.id;
          const response = responses[prompt.id];
          const isRunning = runningId === prompt.id;
          const isReference = isReferencePrompt(prompt.body);
          const hasTools = hasToolTokens(prompt.body);
          const isRunnable = hasAnyTokens(prompt.body);

          return (
            <div
              key={prompt.id}
              className={`rounded-xl border transition-colors ${
                isExpanded
                  ? "border-zinc-700/60 bg-zinc-800/20"
                  : "border-transparent hover:bg-white/[0.02]"
              }`}
            >
              {/* Header */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : prompt.id)}
                className="flex items-center justify-between py-2.5 px-3 cursor-pointer group"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`transition-transform duration-200 text-zinc-500 ${
                      isExpanded ? "rotate-0" : "-rotate-90"
                    }`}
                  >
                    <IconChevron size={12} />
                  </span>
                  <span className="text-sm text-zinc-200 font-medium truncate">{prompt.title}</span>
                  {prompt.tags.slice(0, 2).map((t) => (
                    <Badge key={t} color="#555" small>{t}</Badge>
                  ))}
                  <span className="text-[10px] text-zinc-600">{prompt.usageCount || 0}×</span>
                  {prompt.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); onCopy(prompt); }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <IconCopy size={12} /> {copiedId === prompt.id ? "Copied!" : "Copy"}
                  </button>
                  {isRunnable && hasLLM && (
                    <button
                      onClick={(e) => handleRun(prompt, e)}
                      disabled={isRunning}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs text-purple-400 hover:text-purple-200 hover:bg-purple-500/10 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {isRunning ? <IconLoader size={12} /> : <IconPlay size={12} />}
                      {isRunning ? "Running..." : "Run"}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div className="px-3 pb-3 animate-fadeIn">
                  {/* Body preview */}
                  <div className="ml-6 mb-3 px-3 py-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800/60">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold">
                        {isReference
                          ? "Reference Prompt"
                          : hasTools
                            ? "Template — resolves tools + variables"
                            : "Template — resolves variables"}
                      </div>
                      {isReference && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/40 text-zinc-400">
                          Copy-paste ready
                        </span>
                      )}
                    </div>
                    <div className="text-[13px] text-zinc-400 leading-relaxed whitespace-pre-wrap">
                      {renderBody(resolvedBodies[prompt.id] || prompt.body)}
                    </div>
                  </div>

                  {/* Reference prompt: single copy button */}
                  {isReference && (
                    <div className="ml-6 flex gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); onCopy(prompt); }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/50 transition-colors cursor-pointer"
                      >
                        <IconCopy size={14} /> {copiedId === prompt.id ? "Copied!" : "Copy to Clipboard"}
                      </button>
                    </div>
                  )}

                  {/* Running state */}
                  {isRunnable && isRunning && (
                    <div className="ml-6 flex items-center gap-2 px-3 py-3 text-sm text-zinc-400">
                      <IconLoader size={14} /> Resolving tools and calling AI...
                    </div>
                  )}

                  {/* Response */}
                  {isRunnable && response && !isRunning && (
                    <PromptResponseView
                      response={response}
                      promptId={prompt.id}
                      onCopyForClaudeCode={() => handleCopyForClaudeCode(prompt, response)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

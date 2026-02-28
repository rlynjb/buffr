"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { IconChevron, IconCopy, IconPlay, IconLoader, IconSparkle, IconCheck } from "@/components/icons";
import type { Prompt, PromptResponse } from "@/lib/types";
import { runPrompt, executeToolAction } from "@/lib/api";
import { useProvider } from "@/context/provider-context";
import { isReferencePrompt, renderPromptTokens } from "@/lib/prompt-utils";
import "./prompts-tab.css";

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

function useTypingEffect(text: string, speed: number = 8) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
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
  }, [text, speed]);

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

  const actionStateClass: Record<string, string> = {
    idle: "prompts-tab__response-action-btn--idle",
    running: "prompts-tab__response-action-btn--running",
    success: "prompts-tab__response-action-btn--success",
    error: "prompts-tab__response-action-btn--error",
  };

  return (
    <div className="prompts-tab__response">
      <div className="prompts-tab__response-body">
        <div className="prompts-tab__response-header">
          <IconSparkle size={10} /> AI Response
        </div>
        <div className="prompts-tab__response-text">
          {displayed.split(/(\*\*.*?\*\*)/).map((p, i) =>
            p.startsWith("**") && p.endsWith("**") ? (
              <strong key={i} className="prompts-tab__response-bold">{p.slice(2, -2)}</strong>
            ) : p.startsWith("##") ? (
              <span key={i} className="prompts-tab__response-heading">{p.replace(/^##\s*/, "")}</span>
            ) : (
              <span key={i}>{p}</span>
            )
          )}
          {!done && <span className="prompts-tab__response-cursor" />}
        </div>
      </div>

      {done && (response.suggestedActions?.length || response.artifact) && (
        <div className="prompts-tab__response-actions">
          {response.suggestedActions && response.suggestedActions.length > 0 && (
            <div className="prompts-tab__response-apply-list">
              <div className="prompts-tab__response-action-heading">Apply</div>
              {response.suggestedActions.map((action, idx) => {
                const key = `${promptId}-${idx}`;
                const st = actionStates[key] || "idle";
                return (
                  <button
                    key={idx}
                    onClick={() => handleAction(idx, action.tool, action.params)}
                    disabled={st !== "idle"}
                    className={`prompts-tab__response-action-btn ${actionStateClass[st]}`}
                  >
                    <span className="prompts-tab__response-action-icon">
                      <IconSparkle size={14} />
                    </span>
                    <span className="prompts-tab__response-action-label">{action.label}</span>
                    {st === "running" && <IconLoader size={14} />}
                    {st === "success" && <span className="prompts-tab__response-action-success"><IconCheck size={14} /></span>}
                  </button>
                );
              })}
            </div>
          )}

          {response.artifact && (
            <div className="prompts-tab__response-refine-section">
              <div className="prompts-tab__response-action-heading">Refine with local context</div>
              <button
                onClick={handleCopyRefine}
                className={`prompts-tab__refine-btn ${
                  copied ? "prompts-tab__refine-btn--copied" : "prompts-tab__refine-btn--default"
                }`}
              >
                <span className="prompts-tab__refine-icon">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
                <span className="prompts-tab__refine-label">{copied ? "Copied to clipboard" : "Copy response + context for Claude Code"}</span>
              </button>
              <p className="prompts-tab__refine-hint">
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
      <div className="prompts-tab__empty">
        No prompts yet. Add prompts from the{" "}
        <Link href="/prompts" className="prompts-tab__empty-link">Prompt Library</Link>{" "}
        to see them here with project context auto-filled.
      </div>
    );
  }

  return (
    <div>
      {/* Category filter */}
      <div className="prompts-tab__category-filter">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`prompts-tab__category ${
              activeCategory === cat.key
                ? "prompts-tab__category--active"
                : "prompts-tab__category--inactive"
            }`}
          >
            {cat.label}
          </button>
        ))}
        <span className="prompts-tab__count">
          {filtered.length} prompt{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Accordion list */}
      <div className="prompts-tab__list">
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
              className={`prompts-tab__prompt ${
                isExpanded ? "prompts-tab__prompt--expanded" : "prompts-tab__prompt--collapsed"
              }`}
            >
              {/* Header */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpandedId(isExpanded ? null : prompt.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : prompt.id);
                  }
                }}
                className="prompts-tab__prompt-header"
                aria-expanded={isExpanded}
              >
                <div className="prompts-tab__prompt-info">
                  <span
                    className={`prompts-tab__prompt-chevron ${
                      isExpanded ? "prompts-tab__prompt-chevron--open" : "prompts-tab__prompt-chevron--closed"
                    }`}
                  >
                    <IconChevron size={12} />
                  </span>
                  <span className="prompts-tab__prompt-title">{prompt.title}</span>
                  {prompt.tags.slice(0, 2).map((t) => (
                    <Badge key={t} color="#555" small>{t}</Badge>
                  ))}
                  <span className="prompts-tab__prompt-usage">{prompt.usageCount || 0}×</span>
                  {prompt.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                </div>
                <div className="prompts-tab__prompt-actions">
                  <button
                    onClick={(e) => { e.stopPropagation(); onCopy(prompt); }}
                    className="prompts-tab__prompt-btn--copy"
                  >
                    <IconCopy size={12} /> {copiedId === prompt.id ? "Copied!" : "Copy"}
                  </button>
                  {isRunnable && hasLLM && (
                    <button
                      onClick={(e) => handleRun(prompt, e)}
                      disabled={isRunning}
                      className="prompts-tab__prompt-btn--run"
                    >
                      {isRunning ? <IconLoader size={12} /> : <IconPlay size={12} />}
                      {isRunning ? "Running..." : "Run"}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div className="prompts-tab__prompt-expanded">
                  {/* Body preview */}
                  <div className="prompts-tab__body-preview">
                    <div className="prompts-tab__body-header-row">
                      <div className="prompts-tab__body-header">
                        {isReference
                          ? "Reference Prompt"
                          : hasTools
                            ? "Template — resolves tools + variables"
                            : "Template — resolves variables"}
                      </div>
                      {isReference && (
                        <span className="prompts-tab__body-ref-badge">Copy-paste ready</span>
                      )}
                    </div>
                    <div className="prompts-tab__body-text">
                      {renderPromptTokens(resolvedBodies[prompt.id] || prompt.body, "prompts-tab__token--tool", "prompts-tab__token--variable")}
                    </div>
                  </div>

                  {isReference && (
                    <div className="prompts-tab__ref-actions">
                      <button
                        onClick={(e) => { e.stopPropagation(); onCopy(prompt); }}
                        className="prompts-tab__ref-copy-btn"
                      >
                        <IconCopy size={14} /> {copiedId === prompt.id ? "Copied!" : "Copy to Clipboard"}
                      </button>
                    </div>
                  )}

                  {isRunnable && isRunning && (
                    <div className="prompts-tab__running">
                      <IconLoader size={14} /> Resolving tools and calling AI...
                    </div>
                  )}

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

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import { IconBack, IconSearch, IconPlus, IconPrompt, IconEdit, IconCopy, IconTrash } from "@/components/icons";
import { sourceColor } from "@/components/icons";
import type { Prompt, ToolIntegration } from "@/lib/types";
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  listIntegrations,
} from "@/lib/api";

function isReferencePrompt(body: string): boolean {
  return !body.includes("{{");
}

function renderTokens(body: string) {
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

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<ToolIntegration[]>([]);

  // Form state
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");

  useEffect(() => {
    load();
    listIntegrations().then(setIntegrations).catch(() => setIntegrations([]));
  }, []);

  async function load() {
    try {
      const data = await listPrompts();
      setPrompts(data);
    } catch (err) {
      console.error("Failed to load prompts:", err);
    } finally {
      setLoading(false);
    }
  }

  function openNew() {
    setEditing(null);
    setTitle("");
    setBody("");
    setTags("");
    setScope("global");
    setModalOpen(true);
  }

  function openEdit(prompt: Prompt) {
    setEditing(prompt);
    setTitle(prompt.title);
    setBody(prompt.body);
    setTags(prompt.tags.join(", "));
    setScope(prompt.scope === "global" ? "global" : "project");
    setModalOpen(true);
  }

  async function handleSave() {
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (editing) {
      const updated = await updatePrompt(editing.id, { title, body, tags: parsedTags, scope });
      setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } else {
      const created = await createPrompt({ title, body, tags: parsedTags, scope });
      setPrompts((prev) => [created, ...prev]);
    }
    setModalOpen(false);
  }

  async function handleDelete(id: string) {
    await deletePrompt(id);
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }

  async function handleCopy(prompt: Prompt) {
    await navigator.clipboard.writeText(prompt.body);
    setCopied(prompt.id);
    setTimeout(() => setCopied(null), 1500);
  }

  const allTags = Array.from(new Set(prompts.flatMap((p) => p.tags))).sort();

  const filtered = prompts
    .filter((p) => {
      const matchesQuery = !query ||
        p.title.toLowerCase().includes(query.toLowerCase()) ||
        p.body.toLowerCase().includes(query.toLowerCase()) ||
        p.tags.some((t) => t.toLowerCase().includes(query.toLowerCase()));
      const matchesTag = !activeTag || p.tags.includes(activeTag);
      return matchesQuery && matchesTag;
    })
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

  const allTools = integrations.flatMap((i) =>
    i.tools.map((t) => ({ name: t.name, integration: i.id }))
  );

  return (
    <div>
      <Link
        href="/"
        className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 mb-6 transition-colors"
      >
        <IconBack size={14} /> Dashboard
      </Link>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Prompt Library</h1>
        <Button size="sm" onClick={openNew}>
          <IconPlus size={14} /> New Prompt
        </Button>
      </div>

      {/* Search + Tag Filter */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600">
            <IconSearch size={14} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900/80 border border-zinc-700/50 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors"
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                !activeTag
                  ? "bg-zinc-700/50 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              All
            </button>
            {allTags.slice(0, 6).map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTag === tag
                    ? "bg-zinc-700/50 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Prompt list */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-xl border border-zinc-800/60 bg-zinc-900/30 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-500 text-sm mb-4">
            {prompts.length === 0
              ? "No prompts yet. Add your first prompt to get started."
              : "No prompts match your search."}
          </p>
          {prompts.length === 0 && (
            <Button onClick={openNew}>
              <IconPlus size={14} /> Add First Prompt
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((prompt) => {
            const isRef = isReferencePrompt(prompt.body);

            return (
              <div
                key={prompt.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700/60 transition-colors group"
              >
                <span className={isRef ? "text-zinc-500" : "text-purple-400"}>
                  <IconPrompt size={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200 truncate">{prompt.title}</span>
                    {isRef && <Badge color="#71717a" small>reference</Badge>}
                    {prompt.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} color="#555" small>{tag}</Badge>
                    ))}
                    {prompt.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                    <span className="text-[10px] text-zinc-600">{prompt.usageCount || 0}×</span>
                  </div>
                  <div className="text-xs text-zinc-500 truncate mt-0.5">
                    {renderTokens(prompt.body.slice(0, 120))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEdit(prompt)}
                    className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
                    title="Edit"
                  >
                    <IconEdit size={14} />
                  </button>
                  <button
                    onClick={() => handleCopy(prompt)}
                    className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
                    title="Copy"
                  >
                    <IconCopy size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(prompt.id)}
                    className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors cursor-pointer"
                    title="Delete"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                {copied === prompt.id && (
                  <span className="text-[10px] text-emerald-400 shrink-0">Copied!</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Available Tools Reference */}
      {allTools.length > 0 && (
        <div className="mt-8 p-4 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-2">
            Available Tools
          </div>
          <p className="text-xs text-zinc-600 mb-3">
            Use <code className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[11px] font-mono">{"{{tool:name}}"}</code> in your prompt body to inject tool output.
          </p>
          <div className="flex flex-wrap gap-2">
            {allTools.map((t) => (
              <span
                key={t.name}
                className="text-xs font-mono px-2 py-1 rounded border border-zinc-700/50 bg-zinc-800/30"
                style={{ color: sourceColor(t.integration) }}
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* New/Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Prompt" : "New Prompt"}
      >
        <div className="space-y-4">
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Debug React render loop"
          />
          <div>
            <TextArea
              label="Prompt Body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"You are debugging a {{project.stack}} app...\n\nOpen items:\n{{tool:github_list_issues}}"}
              rows={6}
              mono
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              Variables: {"{{project.name}}"}, {"{{project.stack}}"}, {"{{lastSession.goal}}"}. Tools: {"{{tool:name}}"}.
            </p>
          </div>
          <Input
            label="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="debug, react, performance"
          />
          <div>
            <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-2 block">
              Scope
            </label>
            <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden w-fit">
              <button
                onClick={() => setScope("global")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  scope === "global"
                    ? "bg-zinc-700/50 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                Global
              </button>
              <button
                onClick={() => setScope("project")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  scope === "project"
                    ? "bg-zinc-700/50 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                Project
              </button>
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!title.trim() || !body.trim()}>
              {editing ? "Update" : "Save Prompt"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

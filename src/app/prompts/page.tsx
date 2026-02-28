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
import { isReferencePrompt, renderPromptTokens } from "@/lib/prompt-utils";
import "./page.css";

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
      <Link href="/" className="prompts-page__back">
        <IconBack size={14} /> Dashboard
      </Link>

      <div className="prompts-page__header">
        <h1 className="prompts-page__title">Prompt Library</h1>
        <Button size="sm" onClick={openNew}>
          <IconPlus size={14} /> New Prompt
        </Button>
      </div>

      {/* Search + Tag Filter */}
      <div className="prompts-page__filter-row">
        <div className="prompts-page__search">
          <span className="prompts-page__search-icon">
            <IconSearch size={14} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts..."
            className="prompts-page__search-input"
          />
        </div>
        {allTags.length > 0 && (
          <div className="prompts-page__tag-filter">
            <button
              onClick={() => setActiveTag(null)}
              className={`prompts-page__tag-btn ${
                !activeTag
                  ? "prompts-page__tag-btn--active"
                  : "prompts-page__tag-btn--inactive"
              }`}
            >
              All
            </button>
            {allTags.slice(0, 6).map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`prompts-page__tag-btn ${
                  activeTag === tag
                    ? "prompts-page__tag-btn--active"
                    : "prompts-page__tag-btn--inactive"
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
            <div key={i} className="prompts-page__skeleton" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="prompts-page__empty">
          <p className="prompts-page__empty-text">
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
              <div key={prompt.id} className="prompts-page__prompt">
                <span className={isRef ? "prompts-page__prompt-icon--ref" : "prompts-page__prompt-icon--dynamic"}>
                  <IconPrompt size={16} />
                </span>
                <div className="prompts-page__prompt-body">
                  <div className="prompts-page__prompt-header">
                    <span className="prompts-page__prompt-title">{prompt.title}</span>
                    {isRef && <Badge color="#71717a" small>reference</Badge>}
                    {prompt.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} color="#555" small>{tag}</Badge>
                    ))}
                    {prompt.scope === "project" && <Badge color="#60a5fa" small>project</Badge>}
                    <span className="prompts-page__prompt-usage">{prompt.usageCount || 0}×</span>
                  </div>
                  <div className="prompts-page__prompt-preview">
                    {renderPromptTokens(prompt.body.slice(0, 120), "prompts-page__token--tool", "prompts-page__token--variable")}
                  </div>
                </div>
                <div className="prompts-page__prompt-actions">
                  <button
                    onClick={() => openEdit(prompt)}
                    className="prompts-page__prompt-action-btn"
                    title="Edit"
                  >
                    <IconEdit size={14} />
                  </button>
                  <button
                    onClick={() => handleCopy(prompt)}
                    className="prompts-page__prompt-action-btn"
                    title="Copy"
                  >
                    <IconCopy size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(prompt.id)}
                    className="prompts-page__prompt-action-btn--delete"
                    title="Delete"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                {copied === prompt.id && (
                  <span className="prompts-page__prompt-copied">Copied!</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Available Tools Reference */}
      {allTools.length > 0 && (
        <div className="prompts-page__tools-ref">
          <div className="prompts-page__tools-ref-label">
            Available Tools
          </div>
          <p className="prompts-page__tools-ref-desc">
            Use <code className="prompts-page__token--tool">{"{{tool:name}}"}</code> in your prompt body to inject tool output.
          </p>
          <div className="prompts-page__tools-ref-list">
            {allTools.map((t) => (
              <span
                key={t.name}
                className="prompts-page__tools-ref-item"
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
            <p className="prompts-page__modal-hint">
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
            <label className="prompts-page__scope-label">
              Scope
            </label>
            <div className="prompts-page__scope-toggle">
              <button
                onClick={() => setScope("global")}
                className={`prompts-page__scope-btn ${
                  scope === "global"
                    ? "prompts-page__scope-btn--active"
                    : "prompts-page__scope-btn--inactive"
                }`}
              >
                Global
              </button>
              <button
                onClick={() => setScope("project")}
                className={`prompts-page__scope-btn ${
                  scope === "project"
                    ? "prompts-page__scope-btn--active"
                    : "prompts-page__scope-btn--inactive"
                }`}
              >
                Project
              </button>
            </div>
          </div>
          <div className="prompts-page__modal-footer">
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

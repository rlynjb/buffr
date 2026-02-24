"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import type { Prompt } from "@/lib/types";
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
} from "@/lib/api";

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState<"global" | string>("global");

  useEffect(() => {
    load();
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
    setScope(prompt.scope);
    setModalOpen(true);
  }

  async function handleSave() {
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (editing) {
      const updated = await updatePrompt(editing.id, {
        title,
        body,
        tags: parsedTags,
        scope,
      });
      setPrompts((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p))
      );
    } else {
      const created = await createPrompt({
        title,
        body,
        tags: parsedTags,
        scope,
      });
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

  // All unique tags
  const allTags = Array.from(
    new Set(prompts.flatMap((p) => p.tags))
  ).sort();

  // Filter
  const filtered = prompts.filter((p) => {
    const matchesQuery =
      !query ||
      p.title.toLowerCase().includes(query.toLowerCase()) ||
      p.body.toLowerCase().includes(query.toLowerCase()) ||
      p.tags.some((t) => t.toLowerCase().includes(query.toLowerCase()));
    const matchesTag = !activeTag || p.tags.includes(activeTag);
    return matchesQuery && matchesTag;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground font-mono">
            Prompts
          </h1>
          <p className="text-sm text-muted mt-1">
            Your collected prompts for AI tools. Use{" "}
            <code className="text-xs bg-background px-1 py-0.5 rounded font-mono">
              {"{{project.name}}"}
            </code>{" "}
            for template variables.
          </p>
        </div>
        <Button onClick={openNew}>New Prompt</Button>
      </div>

      {/* Search + Tags */}
      <div className="space-y-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search prompts..."
          className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                !activeTag
                  ? "bg-accent/15 text-accent"
                  : "bg-card text-muted hover:text-foreground"
              }`}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() =>
                  setActiveTag(activeTag === tag ? null : tag)
                }
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  activeTag === tag
                    ? "bg-accent/15 text-accent"
                    : "bg-card text-muted hover:text-foreground"
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
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-border bg-card animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted text-sm mb-4">
            {prompts.length === 0
              ? "No prompts yet. Add your first prompt to get started."
              : "No prompts match your search."}
          </p>
          {prompts.length === 0 && (
            <Button onClick={openNew}>Add First Prompt</Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((prompt) => (
            <Card key={prompt.id}>
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-sm text-foreground">
                  {prompt.title}
                </h3>
                <Badge variant={prompt.scope === "global" ? "default" : "accent"}>
                  {prompt.scope === "global" ? "global" : "project"}
                </Badge>
              </div>
              <pre className="text-xs text-muted font-mono whitespace-pre-wrap line-clamp-3 mb-3">
                {prompt.body}
              </pre>
              {prompt.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {prompt.tags.map((tag) => (
                    <Badge key={tag} variant="default">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleCopy(prompt)}
                  className="text-xs text-accent hover:underline"
                >
                  {copied === prompt.id ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={() => openEdit(prompt)}
                  className="text-xs text-muted hover:text-foreground hover:underline"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(prompt.id)}
                  className="text-xs text-error hover:underline"
                >
                  Delete
                </button>
              </div>
            </Card>
          ))}
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
          <TextArea
            label="Prompt"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"You are debugging a {{project.stack}} app called {{project.name}}..."}
            rows={6}
          />
          <Input
            label="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="debug, react, performance"
          />
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Scope
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "global"}
                  onChange={() => setScope("global")}
                  className="accent-accent"
                />
                Global
              </label>
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <Button
              variant="secondary"
              onClick={() => setModalOpen(false)}
            >
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

"use client";

import { useState, useEffect, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { TextArea } from "@/components/ui/textarea";
import {
  IconSearch, IconPlus, IconEdit, IconTrash, IconCheck,
  IconEye, IconGitHub, IconLoader,
} from "@/components/icons";
import type { DevItem, DevItemCategory, Project } from "@/lib/types";
import {
  listDevItems, createDevItem, updateDevItem, deleteDevItemApi, pushDevItems,
} from "@/lib/api";
import "./dev-tab.css";

interface DevTabProps {
  project: Project;
}

const CATEGORIES: Array<{ key: "all" | DevItemCategory; label: string }> = [
  { key: "all", label: "All" },
  { key: "ai-rules", label: "AI Rules" },
  { key: "skills", label: "Skills" },
  { key: "community-skills", label: "Community Skills" },
];

const CATEGORY_COLORS: Record<DevItemCategory, string> = {
  "ai-rules": "#60a5fa",
  skills: "#34d399",
  "community-skills": "#a78bfa",
};

const CATEGORY_LABELS: Record<DevItemCategory, string> = {
  "ai-rules": "AI Rule",
  skills: "Skill",
  "community-skills": "Community Skill",
};

const ADAPTERS = [
  { id: "claude-code", name: "Claude Code", file: "CLAUDE.md", icon: "C", color: "#c084fc" },
  { id: "cursor", name: "Cursor", file: ".cursorrules", icon: "\u2318", color: "#22d3ee" },
  { id: "copilot", name: "Copilot", file: "copilot-instructions.md", icon: "\u2299", color: "#8b949e" },
  { id: "windsurf", name: "Windsurf", file: ".windsurfrules", icon: "W", color: "#34d399" },
  { id: "aider", name: "Aider", file: ".aider.conf.yml", icon: "A", color: "#fbbf24" },
  { id: "continue", name: "Continue", file: ".continuerules", icon: "\u2192", color: "#f472b6" },
];

function getDirectory(item: DevItem): string {
  return item.category;
}

export function DevTab({ project }: DevTabProps) {
  const [items, setItems] = useState<DevItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<"all" | DevItemCategory>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // CRUD modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DevItem | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<DevItemCategory>("ai-rules");
  const [filename, setFilename] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [tags, setTags] = useState("");

  // Push
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [selectedAdapters, setSelectedAdapters] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    try {
      const data = await listDevItems(project.id);
      setItems(data);
    } catch (err) {
      console.error("Failed to load dev items:", err);
    } finally {
      setLoading(false);
    }
  }

  // Modal helpers
  function openNew(cat?: DevItemCategory) {
    setEditing(null);
    setTitle("");
    setContent("");
    setCategory(cat || "ai-rules");
    setFilename("");
    setScope("global");
    setTags("");
    setModalOpen(true);
  }

  function openEdit(item: DevItem) {
    setEditing(item);
    setTitle(item.title);
    setContent(item.content);
    setCategory(item.category);
    setFilename(item.filename);
    setScope(item.scope === "global" ? "global" : "project");
    setTags(item.tags.join(", "));
    setModalOpen(true);
  }

  async function handleSave() {
    const parsedTags = tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const resolvedFilename = filename.trim() || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
    const resolvedScope = scope === "project" ? project.id : "global";

    if (editing) {
      const updated = await updateDevItem(editing.id, {
        title, content, category, filename: resolvedFilename, tags: parsedTags, scope: resolvedScope,
      });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } else {
      const created = await createDevItem({
        title, content, category, filename: resolvedFilename, tags: parsedTags, scope: resolvedScope,
      });
      setItems((prev) => [created, ...prev]);
    }
    setModalOpen(false);
  }

  async function handleDelete(id: string) {
    await deleteDevItemApi(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function handlePush() {
    if (!project.githubRepo) return;
    setPushing(true);
    try {
      await pushDevItems(project.id, project.githubRepo, Array.from(selectedAdapters));
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  function toggleAdapter(id: string) {
    setSelectedAdapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Filter and group
  const filtered = useMemo(() => {
    return items
      .filter((i) => {
        const matchesCategory = activeCategory === "all" || i.category === activeCategory;
        const matchesQuery = !query ||
          i.title.toLowerCase().includes(query.toLowerCase()) ||
          i.filename.toLowerCase().includes(query.toLowerCase()) ||
          i.tags.some((t) => t.includes(query.toLowerCase()));
        return matchesCategory && matchesQuery;
      })
      .sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.filename.localeCompare(b.filename);
      });
  }, [items, activeCategory, query]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
    return counts;
  }, [items]);

  let lastDir = "";

  return (
    <div>
      {/* Header */}
      <div className="dev-tab__header">
        <div className="dev-tab__search">
          <span className="dev-tab__search-icon"><IconSearch size={14} /></span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files..."
            className="dev-tab__search-input"
          />
        </div>
        <Button size="sm" onClick={() => openNew()}>
          <IconPlus size={14} /> New
        </Button>
        {project.githubRepo && (
          <Button
            size="sm"
            variant={pushSuccess ? "secondary" : "primary"}
            onClick={handlePush}
            disabled={pushing || items.length === 0}
          >
            {pushing ? <IconLoader size={14} /> : pushSuccess ? <IconCheck size={14} /> : <IconGitHub size={14} />}
            {pushing ? "Pushing..." : pushSuccess ? "Pushed" : "Push to Repo"}
          </Button>
        )}
      </div>

      {/* Category filter */}
      <div className="dev-tab__categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`dev-tab__category ${
              activeCategory === cat.key ? "dev-tab__category--active" : "dev-tab__category--inactive"
            }`}
          >
            {cat.label}
            {categoryCounts[cat.key] ? (
              <span className="dev-tab__category-count">{categoryCounts[cat.key]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Adapters */}
      <div className="dev-tab__adapters">
        <p className="dev-tab__adapters-label">Push adapters to:</p>
        <div className="dev-tab__adapters-list">
          {ADAPTERS.map((a) => (
            <label key={a.id} className="dev-tab__adapter">
              <input
                type="checkbox"
                checked={selectedAdapters.has(a.id)}
                onChange={() => toggleAdapter(a.id)}
                className="dev-tab__adapter-checkbox"
              />
              <span
                className="dev-tab__adapter-icon"
                style={{ color: selectedAdapters.has(a.id) ? a.color : "#555" }}
              >
                {a.icon}
              </span>
              <span className={`dev-tab__adapter-name ${selectedAdapters.has(a.id) ? "" : "dev-tab__adapter-name--dim"}`}>
                {a.name}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* File tree */}
      {loading ? (
        <div className="dev-tab__loading">
          {[1, 2, 3].map((i) => <div key={i} className="dev-tab__skeleton" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="dev-tab__empty">
          {items.length === 0
            ? "No .dev files yet. Create your first AI rule or skill."
            : "No files match your search."}
        </div>
      ) : (
        <div className="dev-tab__tree">
          {filtered.map((item) => {
            const dir = getDirectory(item);
            const showDirHeader = dir !== lastDir;
            lastDir = dir;
            const isExpanded = expandedId === item.id;
            const color = CATEGORY_COLORS[item.category];

            return (
              <div key={item.id}>
                {showDirHeader && (
                  <div className="dev-tab__dir-header">{item.category}/</div>
                )}

                <button
                  className={`dev-tab__file-row ${isExpanded ? "dev-tab__file-row--expanded" : ""}`}
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  <span className="dev-tab__file-dot" style={{ backgroundColor: color }} />
                  <span className="dev-tab__file-name">{item.filename}</span>
                  <Badge color={item.scope === "global" ? "#71717a" : "#60a5fa"} small>
                    {item.scope === "global" ? "global" : "project"}
                  </Badge>
                  {item.tags.slice(0, 2).map((t) => (
                    <Badge key={t} color="#555" small>{t}</Badge>
                  ))}
                  <span className="dev-tab__file-hint">
                    <IconEye size={12} />
                  </span>
                </button>

                {isExpanded && (
                  <div className="dev-tab__expanded">
                    <div className="dev-tab__expanded-header">
                      <span className="dev-tab__expanded-path">{item.path}</span>
                      <Badge color={color} small>{CATEGORY_LABELS[item.category]}</Badge>
                      <button onClick={() => openEdit(item)} className="dev-tab__expanded-btn">
                        <IconEdit size={11} /> Edit
                      </button>
                      <button onClick={() => handleDelete(item.id)} className="dev-tab__expanded-btn--delete">
                        <IconTrash size={11} /> Delete
                      </button>
                    </div>
                    <div className="dev-tab__expanded-content">
                      <pre className="dev-tab__expanded-pre">{item.content}</pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New/Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit File" : "New File"}
      >
        <div className="dev-tab__modal-form">
          <div>
            <label className="dev-tab__modal-label">Category</label>
            <div className="dev-tab__modal-categories">
              {(["ai-rules", "skills", "community-skills"] as DevItemCategory[]).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`dev-tab__modal-cat ${category === cat ? "dev-tab__modal-cat--active" : "dev-tab__modal-cat--inactive"}`}
                  style={category === cat ? { borderColor: CATEGORY_COLORS[cat] } : undefined}
                >
                  <span className="dev-tab__modal-cat-dot" style={{ backgroundColor: CATEGORY_COLORS[cat] }} />
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>

          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Strict TypeScript rules"
          />

          <Input
            label="Filename"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "auto-generated from title"}
          />

          <p className="dev-tab__modal-path-preview">
            .dev/{category}/{filename || (title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "...")}
          </p>

          <div>
            <TextArea
              label="Content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your rule or skill content..."
              rows={8}
              mono
            />
          </div>

          <Input
            label="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="typescript, quality"
          />

          <div>
            <label className="dev-tab__modal-label">Scope</label>
            <div className="dev-tab__modal-scope">
              <button
                onClick={() => setScope("global")}
                className={`dev-tab__modal-scope-btn ${scope === "global" ? "dev-tab__modal-scope-btn--active" : "dev-tab__modal-scope-btn--inactive"}`}
              >
                Global
              </button>
              <button
                onClick={() => setScope("project")}
                className={`dev-tab__modal-scope-btn ${scope === "project" ? "dev-tab__modal-scope-btn--active" : "dev-tab__modal-scope-btn--inactive"}`}
              >
                Project
              </button>
            </div>
          </div>

          <div className="dev-tab__modal-footer">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!title.trim() || !content.trim()}>
              {editing ? "Update" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

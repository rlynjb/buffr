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
import type { BuffrSpecItem, BuffrSpecCategory, BuffrSpecStatus, Project } from "@/lib/types";
import {
  listBuffrSpecItems, createBuffrSpecItem, updateBuffrSpecItem,
  deleteBuffrSpecItemApi, pushBuffrSpecItems,
} from "@/lib/api";
import "./doc-tab.css";

interface BuffrSpecsTabProps {
  project: Project;
}

const CATEGORIES: Array<{ key: "all" | BuffrSpecCategory; label: string }> = [
  { key: "all", label: "All" },
  { key: "features", label: "Features" },
  { key: "bugs", label: "Bugs" },
  { key: "tests", label: "Tests" },
  { key: "phases", label: "Phases" },
  { key: "migrations", label: "Migrations" },
  { key: "refactors", label: "Refactors" },
  { key: "prompts", label: "Prompts" },
  { key: "performance", label: "Performance" },
  { key: "integrations", label: "Integrations" },
];

const CATEGORY_COLORS: Record<BuffrSpecCategory, string> = {
  features: "#34d399",
  bugs: "#ef4444",
  tests: "#fbbf24",
  phases: "#818cf8",
  migrations: "#f472b6",
  refactors: "#38bdf8",
  prompts: "#c084fc",
  performance: "#fb923c",
  integrations: "#22d3ee",
};

const CATEGORY_LABELS: Record<BuffrSpecCategory, string> = {
  features: "Feature",
  bugs: "Bug",
  tests: "Test",
  phases: "Phase",
  migrations: "Migration",
  refactors: "Refactor",
  prompts: "Prompt",
  performance: "Perf",
  integrations: "Integration",
};

const STATUS_OPTIONS: Array<{ key: BuffrSpecStatus; label: string; color: string }> = [
  { key: "draft", label: "Draft", color: "#71717a" },
  { key: "ready", label: "Ready", color: "#60a5fa" },
  { key: "in-progress", label: "In Progress", color: "#fbbf24" },
  { key: "done", label: "Done", color: "#34d399" },
];

function getDirectory(item: BuffrSpecItem): string {
  return item.category;
}

export function BuffrSpecsTab({ project }: BuffrSpecsTabProps) {
  const [items, setItems] = useState<BuffrSpecItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<"all" | BuffrSpecCategory>("all");
  const [activeStatus, setActiveStatus] = useState<"all" | BuffrSpecStatus>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // CRUD modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BuffrSpecItem | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<BuffrSpecCategory>("features");
  const [status, setStatus] = useState<BuffrSpecStatus>("draft");
  const [filename, setFilename] = useState("");

  // Push
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    try {
      const data = await listBuffrSpecItems(project.id);
      setItems(data);
    } catch (err) {
      console.error("Failed to load buffr spec items:", err);
    } finally {
      setLoading(false);
    }
  }

  function openNew(cat?: BuffrSpecCategory) {
    setEditing(null);
    setTitle("");
    setContent("");
    setCategory(cat || "features");
    setStatus("draft");
    setFilename("");
    setModalOpen(true);
  }

  function openEdit(item: BuffrSpecItem) {
    setEditing(item);
    setTitle(item.title);
    setContent(item.content);
    setCategory(item.category);
    setStatus(item.status);
    setFilename(item.filename);
    setModalOpen(true);
  }

  async function handleSave() {
    const resolvedFilename = filename.trim() || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;

    if (editing) {
      const updated = await updateBuffrSpecItem(editing.id, {
        title, content, category, status, filename: resolvedFilename, scope: project.id,
      });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } else {
      const created = await createBuffrSpecItem({
        title, content, category, status, filename: resolvedFilename, scope: project.id,
      });
      setItems((prev) => [created, ...prev]);
    }
    setModalOpen(false);
  }

  async function handleDelete(id: string) {
    await deleteBuffrSpecItemApi(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function handlePush() {
    if (!project.githubRepo) return;
    setPushing(true);
    try {
      await pushBuffrSpecItems(project.id, project.githubRepo);
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  const filtered = useMemo(() => {
    return items
      .filter((i) => {
        const matchesCategory = activeCategory === "all" || i.category === activeCategory;
        const matchesStatus = activeStatus === "all" || i.status === activeStatus;
        const matchesQuery = !query ||
          i.title.toLowerCase().includes(query.toLowerCase()) ||
          i.filename.toLowerCase().includes(query.toLowerCase());
        return matchesCategory && matchesStatus && matchesQuery;
      })
      .sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.filename.localeCompare(b.filename);
      });
  }, [items, activeCategory, activeStatus, query]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
    return counts;
  }, [items]);

  let lastDir = "";

  return (
    <div>
      {/* Header */}
      <div className="doc-tab__header">
        <div className="doc-tab__search">
          <span className="doc-tab__search-icon"><IconSearch size={14} /></span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search specs..."
            className="doc-tab__search-input"
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
      <div className="doc-tab__categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`doc-tab__category ${
              activeCategory === cat.key ? "doc-tab__category--active" : "doc-tab__category--inactive"
            }`}
          >
            {cat.label}
            {categoryCounts[cat.key] ? (
              <span className="doc-tab__category-count">{categoryCounts[cat.key]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Status filter */}
      <div className="doc-tab__categories">
        <button
          onClick={() => setActiveStatus("all")}
          className={`doc-tab__category ${activeStatus === "all" ? "doc-tab__category--active" : "doc-tab__category--inactive"}`}
        >
          All Status
        </button>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveStatus(s.key)}
            className={`doc-tab__category ${activeStatus === s.key ? "doc-tab__category--active" : "doc-tab__category--inactive"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* File tree */}
      {loading ? (
        <div className="doc-tab__loading">
          {[1, 2, 3].map((i) => <div key={i} className="doc-tab__skeleton" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="doc-tab__empty">
          {items.length === 0
            ? "No specs yet. Create your first feature, bug, or test spec."
            : "No specs match your search."}
        </div>
      ) : (
        <div className="doc-tab__tree">
          {filtered.map((item) => {
            const dir = getDirectory(item);
            const showDirHeader = dir !== lastDir;
            lastDir = dir;
            const isExpanded = expandedId === item.id;
            const color = CATEGORY_COLORS[item.category];
            const statusOption = STATUS_OPTIONS.find((s) => s.key === item.status);

            return (
              <div key={item.id}>
                {showDirHeader && (
                  <div className="doc-tab__dir-header">{item.category}/</div>
                )}

                <button
                  className={`doc-tab__file-row ${isExpanded ? "doc-tab__file-row--expanded" : ""}`}
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  <span className="doc-tab__file-dot" style={{ backgroundColor: color }} />
                  <span className="doc-tab__file-name">{item.filename}</span>
                  {statusOption && (
                    <Badge color={statusOption.color} small>{statusOption.label}</Badge>
                  )}
                  <span className="doc-tab__file-hint">
                    <IconEye size={12} />
                  </span>
                </button>

                {isExpanded && (
                  <div className="doc-tab__expanded">
                    <div className="doc-tab__expanded-header">
                      <span className="doc-tab__expanded-path">{item.path}</span>
                      <Badge color={color} small>{CATEGORY_LABELS[item.category]}</Badge>
                      <button onClick={() => openEdit(item)} className="doc-tab__expanded-btn">
                        <IconEdit size={11} /> Edit
                      </button>
                      <button onClick={() => handleDelete(item.id)} className="doc-tab__expanded-btn--delete">
                        <IconTrash size={11} /> Delete
                      </button>
                    </div>
                    <div className="doc-tab__expanded-content">
                      <pre className="doc-tab__expanded-pre">{item.content}</pre>
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
        title={editing ? "Edit Spec" : "New Spec"}
        size="wide"
      >
        <div className="doc-tab__modal-form">
          <div>
            <label className="doc-tab__modal-label">Category</label>
            <div className="doc-tab__modal-categories">
              {(["features", "bugs", "tests", "phases", "migrations", "refactors", "prompts", "performance", "integrations"] as BuffrSpecCategory[]).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`doc-tab__modal-cat ${category === cat ? "doc-tab__modal-cat--active" : "doc-tab__modal-cat--inactive"}`}
                  style={category === cat ? { borderColor: CATEGORY_COLORS[cat] } : undefined}
                >
                  <span className="doc-tab__modal-cat-dot" style={{ backgroundColor: CATEGORY_COLORS[cat] }} />
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="doc-tab__modal-label">Status</label>
            <div className="doc-tab__modal-categories">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setStatus(s.key)}
                  className={`doc-tab__modal-cat ${status === s.key ? "doc-tab__modal-cat--active" : "doc-tab__modal-cat--inactive"}`}
                  style={status === s.key ? { borderColor: s.color } : undefined}
                >
                  <span className="doc-tab__modal-cat-dot" style={{ backgroundColor: s.color }} />
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Agent routing refactor"
          />

          <Input
            label="Filename"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "auto-generated from title"}
          />

          <p className="doc-tab__modal-path-preview">
            .buffr/specs/{category}/{filename || (title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "...")}
          </p>

          <div>
            <TextArea
              label="Content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your spec content..."
              rows={8}
              mono
            />
          </div>

          <div className="doc-tab__modal-footer">
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

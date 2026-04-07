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
import type { DocItem, DocItemCategory, Project } from "@/lib/types";
import {
  listDocItems, createDocItem, updateDocItem, deleteDocItemApi, pushDocItems,
} from "@/lib/api";
import "./doc-tab.css";

interface DocTabProps {
  project: Project;
}

const CATEGORIES: Array<{ key: "all" | DocItemCategory; label: string }> = [
  { key: "all", label: "All" },
  { key: "docs", label: "Documentation" },
  { key: "ideas", label: "Ideas" },
  { key: "plans", label: "Plans" },
];

const CATEGORY_COLORS: Record<DocItemCategory, string> = {
  docs: "#fbbf24",
  ideas: "#f472b6",
  plans: "#38bdf8",
};

const CATEGORY_LABELS: Record<DocItemCategory, string> = {
  docs: "Doc",
  ideas: "Idea",
  plans: "Plan",
};

function getDirectory(item: DocItem): string {
  return item.category;
}

export function DocTab({ project }: DocTabProps) {
  const [items, setItems] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<"all" | DocItemCategory>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // CRUD modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DocItem | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<DocItemCategory>("docs");
  const [filename, setFilename] = useState("");

  // Push
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    try {
      const data = await listDocItems(project.id);
      setItems(data);
    } catch (err) {
      console.error("Failed to load doc items:", err);
    } finally {
      setLoading(false);
    }
  }

  // Modal helpers
  function openNew(cat?: DocItemCategory) {
    setEditing(null);
    setTitle("");
    setContent("");
    setCategory(cat || "docs");
    setFilename("");
    setModalOpen(true);
  }

  function openEdit(item: DocItem) {
    setEditing(item);
    setTitle(item.title);
    setContent(item.content);
    setCategory(item.category);
    setFilename(item.filename);
    setModalOpen(true);
  }

  async function handleSave() {
    const resolvedFilename = filename.trim() || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;

    if (editing) {
      const updated = await updateDocItem(editing.id, {
        title, content, category, filename: resolvedFilename, scope: project.id,
      });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } else {
      const created = await createDocItem({
        title, content, category, filename: resolvedFilename, scope: project.id,
      });
      setItems((prev) => [created, ...prev]);
    }
    setModalOpen(false);
  }

  async function handleDelete(id: string) {
    await deleteDocItemApi(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  async function handlePush() {
    if (!project.githubRepo) return;
    setPushing(true);
    try {
      await pushDocItems(project.id, project.githubRepo);
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  // Filter and group
  const filtered = useMemo(() => {
    return items
      .filter((i) => {
        const matchesCategory = activeCategory === "all" || i.category === activeCategory;
        const matchesQuery = !query ||
          i.title.toLowerCase().includes(query.toLowerCase()) ||
          i.filename.toLowerCase().includes(query.toLowerCase());
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
      <div className="doc-tab__header">
        <div className="doc-tab__search">
          <span className="doc-tab__search-icon"><IconSearch size={14} /></span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs..."
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

      {/* File tree */}
      {loading ? (
        <div className="doc-tab__loading">
          {[1, 2, 3].map((i) => <div key={i} className="doc-tab__skeleton" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="doc-tab__empty">
          {items.length === 0
            ? "No .doc files yet. Create your first document, idea, or plan."
            : "No files match your search."}
        </div>
      ) : (
        <div className="doc-tab__tree">
          {filtered.map((item) => {
            const dir = getDirectory(item);
            const showDirHeader = dir !== lastDir;
            lastDir = dir;
            const isExpanded = expandedId === item.id;
            const color = CATEGORY_COLORS[item.category];

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
        title={editing ? "Edit Document" : "New Document"}
        size="wide"
      >
        <div className="doc-tab__modal-form">
          <div>
            <label className="doc-tab__modal-label">Category</label>
            <div className="doc-tab__modal-categories">
              {(["docs", "ideas", "plans"] as DocItemCategory[]).map((cat) => (
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

          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="API Authentication Flow"
          />

          <Input
            label="Filename"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "auto-generated from title"}
          />

          <p className="doc-tab__modal-path-preview">
            .doc/{category}/{filename || (title ? `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md` : "...")}
          </p>

          <div>
            <TextArea
              label="Content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your documentation, idea, or plan..."
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

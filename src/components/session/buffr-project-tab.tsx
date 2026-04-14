"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { TextArea } from "@/components/ui/textarea";
import {
  IconLoader, IconGitHub, IconCheck, IconEdit, IconSparkle,
} from "@/components/icons";
import type { BuffrContextItem, Project } from "@/lib/types";
import {
  listBuffrContextItems, generateBuffrContext, updateBuffrContextItem,
  pushBuffrContextItems,
} from "@/lib/api";
import { useProvider } from "@/context/provider-context";
import "./doc-tab.css";

interface BuffrProjectTabProps {
  project: Project;
}

export function BuffrProjectTab({ project }: BuffrProjectTabProps) {
  const { selected: selectedProvider } = useProvider();
  const [items, setItems] = useState<BuffrContextItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  useEffect(() => {
    loadItems();
  }, [project.id]);

  async function loadItems() {
    try {
      const data = await listBuffrContextItems(project.id);
      setItems(data);
    } catch (err) {
      console.error("Failed to load context items:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const item = await generateBuffrContext(project.id, selectedProvider);
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = item;
          return next;
        }
        return [item, ...prev];
      });
    } catch (err) {
      console.error("Failed to generate context:", err);
    } finally {
      setGenerating(false);
    }
  }

  async function handlePush() {
    if (!project.githubRepo) return;
    setPushing(true);
    try {
      await pushBuffrContextItems(project.id, project.githubRepo);
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error("Push failed:", err);
    } finally {
      setPushing(false);
    }
  }

  function startEdit(item: BuffrContextItem) {
    setEditingId(item.id);
    setEditContent(item.content);
  }

  async function saveEdit() {
    if (!editingId) return;
    try {
      const updated = await updateBuffrContextItem(editingId, { content: editContent });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      console.error("Failed to save edit:", err);
    }
    setEditingId(null);
  }

  return (
    <div>
      {/* Header */}
      <div className="doc-tab__header">
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? <IconLoader size={14} /> : <IconSparkle size={14} />}
          {generating ? "Generating..." : items.length > 0 ? "Regenerate" : "Generate Context"}
        </Button>
        {project.githubRepo && items.length > 0 && (
          <Button
            size="sm"
            variant={pushSuccess ? "secondary" : "primary"}
            onClick={handlePush}
            disabled={pushing}
          >
            {pushing ? <IconLoader size={14} /> : pushSuccess ? <IconCheck size={14} /> : <IconGitHub size={14} />}
            {pushing ? "Pushing..." : pushSuccess ? "Pushed" : "Push to Repo"}
          </Button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="doc-tab__loading">
          {[1, 2].map((i) => <div key={i} className="doc-tab__skeleton" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="doc-tab__empty">
          No project context yet. Click "Generate Context" to create one from your project data and session history.
        </div>
      ) : (
        <div className="doc-tab__tree">
          {items.map((item) => (
            <div key={item.id}>
              <div className="doc-tab__expanded">
                <div className="doc-tab__expanded-header">
                  <span className="doc-tab__expanded-path">{item.path}</span>
                  {editingId === item.id ? (
                    <Button size="sm" onClick={saveEdit}>
                      <IconCheck size={11} /> Save
                    </Button>
                  ) : (
                    <button onClick={() => startEdit(item)} className="doc-tab__expanded-btn">
                      <IconEdit size={11} /> Edit
                    </button>
                  )}
                </div>
                <div className="doc-tab__expanded-content">
                  {editingId === item.id ? (
                    <TextArea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={20}
                      mono
                    />
                  ) : (
                    <pre className="doc-tab__expanded-pre">{item.content}</pre>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

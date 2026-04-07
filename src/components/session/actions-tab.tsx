"use client";

import { useState, useRef, useEffect } from "react";
import { IconSparkle, IconPlus, IconTrash } from "@/components/icons";
import type { ManualActionData } from "@/lib/api";
import "./actions-tab.css";

const PERSONAS = [
  { id: "user-story", label: "User Story", desc: "As a user, I want..." },
  { id: "backend-dev", label: "Backend Dev", desc: "Technical / API focus" },
  { id: "frontend-dev", label: "Frontend Dev", desc: "UI/UX / component focus" },
  { id: "stakeholder", label: "Stakeholder", desc: "Business value focus" },
  { id: "project-manager", label: "Project Manager", desc: "Scope & deliverables" },
] as const;

interface ActionsTabProps {
  actions: ManualActionData[];
  onDone: (id: string) => void;
  onAddManual?: (text: string) => void;
  onDeleteManual?: (id: string) => void;
  onEditManual?: (id: string, text: string) => void;
  onParaphrase?: (text: string, persona?: string) => Promise<string | null>;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

export function ActionsTab({
  actions,
  onDone,
  onAddManual,
  onDeleteManual,
  onEditManual,
  onParaphrase,
  onReorder,
}: ActionsTabProps) {
  const [newItem, setNewItem] = useState("");
  const [paraphrasing, setParaphrasing] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const rewriteRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (editingId && editRef.current) {
      const el = editRef.current;
      el.focus();
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editingId]);

  useEffect(() => {
    if (!rewriteOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (rewriteRef.current && !rewriteRef.current.contains(e.target as Node)) {
        setRewriteOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [rewriteOpen]);

  function startEditing(action: ManualActionData) {
    if (!onEditManual) return;
    setEditingId(action.id);
    setEditText(action.text);
  }

  function commitEdit() {
    if (!editingId || !onEditManual) return;
    const trimmed = editText.trim();
    if (trimmed && trimmed !== actions.find((a) => a.id === editingId)?.text) {
      onEditManual(editingId, trimmed);
    }
    setEditingId(null);
  }

  function handleAdd() {
    const text = newItem.trim();
    if (!text || !onAddManual) return;
    onAddManual(text);
    setNewItem("");
    if (addRef.current) addRef.current.style.height = "auto";
  }

  async function handleParaphrase(persona?: string) {
    if (!onParaphrase || !newItem.trim()) return;
    setRewriteOpen(false);
    setParaphrasing(true);
    try {
      const result = await onParaphrase(newItem.trim(), persona);
      if (result) {
        setNewItem(result);
        requestAnimationFrame(() => {
          const el = addRef.current;
          if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
        });
      }
    } finally {
      setParaphrasing(false);
    }
  }

  return (
    <div>
      {onAddManual && (
        <div className="actions-tab__add">
          <textarea
            ref={addRef}
            rows={1}
            value={newItem}
            onChange={(e) => {
              setNewItem(e.target.value);
              const el = addRef.current;
              if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
            placeholder="Add a task..."
            className="actions-tab__add-input"
          />
          <div className="actions-tab__add-actions">
            {onParaphrase && (
              <>
                <button
                  onClick={() => handleParaphrase()}
                  disabled={paraphrasing || !newItem.trim()}
                  className="actions-tab__add-paraphrase"
                >
                  <IconSparkle size={10} /> {paraphrasing ? "..." : "Rewrite"}
                </button>
                <div className="actions-tab__rewrite-wrap" ref={rewriteRef}>
                  <button
                    onClick={() => setRewriteOpen((o) => !o)}
                    disabled={paraphrasing || !newItem.trim()}
                    className="actions-tab__add-persona"
                  >
                    {paraphrasing ? "..." : "Persona ▾"}
                  </button>
                  {rewriteOpen && (
                    <div className="actions-tab__rewrite-menu">
                      {PERSONAS.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => handleParaphrase(p.id)}
                          className="actions-tab__rewrite-option"
                        >
                          <span className="actions-tab__rewrite-option-label">{p.label}</span>
                          <span className="actions-tab__rewrite-option-desc">{p.desc}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            <button
              onClick={handleAdd}
              disabled={!newItem.trim()}
              className="actions-tab__add-btn"
            >
              <IconPlus size={12} />
            </button>
          </div>
        </div>
      )}

      <hr className="actions-tab__divider" />

      <p className="actions-tab__purpose">
        Track what to work on next. Items carry over between sessions and feed into End Session summaries.
      </p>

      <div className="actions-tab__list">
        {actions.map((action, idx) => (
          <div
            key={action.id}
            draggable={onReorder && !action.done}
            onDragStart={() => { dragIdx.current = idx; }}
            onDragOver={(e) => {
              if (dragIdx.current === null || dragIdx.current === idx) return;
              e.preventDefault();
              setDragOverIdx(idx);
            }}
            onDragLeave={() => { if (dragOverIdx === idx) setDragOverIdx(null); }}
            onDrop={() => {
              if (dragIdx.current !== null && dragIdx.current !== idx && onReorder) {
                onReorder(dragIdx.current, idx);
              }
              dragIdx.current = null;
              setDragOverIdx(null);
            }}
            onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
            className={`actions-tab__action ${
              action.done
                ? "actions-tab__action--done"
                : "actions-tab__action--default"
            } ${dragOverIdx === idx ? "actions-tab__action--drag-over" : ""}`}
          >
            <div className="actions-tab__action-row">
              {onReorder && !action.done && (
                <span className="actions-tab__drag-handle" aria-hidden="true">⠿</span>
              )}
              <span className="actions-tab__action-number">{idx + 1}</span>
              {editingId === action.id ? (
                <textarea
                  ref={editRef}
                  rows={1}
                  value={editText}
                  onChange={(e) => {
                    setEditText(e.target.value);
                    const el = editRef.current;
                    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
                  }}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="actions-tab__action-edit"
                />
              ) : (
                <span
                  className={`actions-tab__action-text ${
                    action.done ? "actions-tab__action-text--done" : ""
                  } ${onEditManual ? "actions-tab__action-text--editable" : ""}`}
                  onClick={() => !action.done && startEditing(action)}
                >
                  {action.text}
                </span>
              )}
              {!action.done && (
                <div className="actions-tab__action-buttons">
                  <button onClick={() => onDone(action.id)} className="actions-tab__action-btn--done">
                    Done
                  </button>
                  {onDeleteManual && (
                    <button onClick={() => onDeleteManual(action.id)} className="actions-tab__action-btn--skip">
                      <IconTrash size={10} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

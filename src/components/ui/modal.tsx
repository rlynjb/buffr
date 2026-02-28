"use client";

import { useEffect, useRef } from "react";
import { IconX } from "@/components/icons";
import "./modal.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, subtitle, children }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="modal__backdrop" />
      <div className="modal__content" role="dialog" aria-modal="true">
        <div className="modal__header">
          <div>
            <h3 className="modal__title">{title}</h3>
            {subtitle && (
              <p className="modal__subtitle">{subtitle}</p>
            )}
          </div>
          <button onClick={onClose} className="modal__close" aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal__body">
          {children}
        </div>
      </div>
    </div>
  );
}

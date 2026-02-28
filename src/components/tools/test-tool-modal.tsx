"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { executeToolAction } from "@/lib/api";
import "./test-tool-modal.css";

interface TestToolModalProps {
  toolName: string | null;
  open: boolean;
  onClose: () => void;
}

export function TestToolModal({ toolName, open, onClose }: TestToolModalProps) {
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  function handleClose() {
    setInput("{}");
    setResult(null);
    onClose();
  }

  async function handleTest() {
    if (!toolName) return;
    setTesting(true);
    setResult(null);
    try {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(input);
      } catch {
        setResult("Error: Invalid JSON input");
        setTesting(false);
        return;
      }
      const res = await executeToolAction(toolName, parsed);
      setResult(JSON.stringify(res, null, 2));
    } catch (err) {
      setResult(
        `Error: ${err instanceof Error ? err.message : "Execution failed"}`
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Test: ${toolName || ""}`}>
      <div className="test-modal__body">
        <div>
          <label className="test-modal__label">
            Input (JSON)
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            className="test-modal__textarea"
            placeholder='{"ownerRepo": "user/repo"}'
          />
        </div>
        <Button onClick={handleTest} loading={testing}>
          {testing ? "Running..." : "Execute"}
        </Button>
        {result && (
          <pre className="test-modal__result">
            {result}
          </pre>
        )}
      </div>
    </Modal>
  );
}

"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { executeToolAction } from "@/lib/api";

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
      <div className="space-y-4">
        <div>
          <label className="text-[11px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5 block">
            Input (JSON)
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-700/50 bg-zinc-900/80 px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 resize-y"
            placeholder='{"ownerRepo": "user/repo"}'
          />
        </div>
        <Button onClick={handleTest} loading={testing}>
          {testing ? "Running..." : "Execute"}
        </Button>
        {result && (
          <pre className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
            {result}
          </pre>
        )}
      </div>
    </Modal>
  );
}

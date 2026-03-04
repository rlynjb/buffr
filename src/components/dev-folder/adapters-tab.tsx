"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconEye, IconRefresh } from "@/components/icons";
import "./adapters-tab.css";

interface AdaptersTabProps {
  detectedAdapters: string[];
}

const ADAPTERS = [
  { id: "claude", name: "Claude Code", file: "CLAUDE.md", icon: "C", color: "#c084fc", desc: "Points Claude to .dev/ files for project context, conventions, and templates" },
  { id: "cursor", name: "Cursor", file: ".cursorrules", icon: "\u2318", color: "#22d3ee", desc: "Loads .dev/ standards into Cursor's context for inline suggestions" },
  { id: "copilot", name: "GitHub Copilot", file: "copilot-instructions.md", icon: "\u2299", color: "#8b949e", desc: "References .dev/ coding guidelines for Copilot completions" },
  { id: "windsurf", name: "Windsurf", file: ".windsurfrules", icon: "W", color: "#34d399", desc: "Loads .dev/ context into Windsurf coding sessions" },
  { id: "aider", name: "Aider", file: ".aider.conf.yml", icon: "A", color: "#fbbf24", desc: "Includes .dev/ files in Aider's context window" },
  { id: "continue", name: "Continue", file: ".continuerules", icon: "\u2192", color: "#f472b6", desc: "Maps .dev/ standards to Continue's format" },
];

export function AdaptersTab({ detectedAdapters }: AdaptersTabProps) {
  return (
    <div className="adapters-tab">
      <div className="adapters-tab__list">
        {ADAPTERS.map((adapter) => {
          const isDetected = detectedAdapters.includes(adapter.id);

          return (
            <div
              key={adapter.id}
              className={`adapters-tab__card ${isDetected ? "" : "adapters-tab__card--undetected"}`}
            >
              <div
                className="adapters-tab__icon"
                style={{
                  background: `${adapter.color}18`,
                  color: adapter.color,
                  border: `1px solid ${adapter.color}30`,
                }}
              >
                {adapter.icon}
              </div>

              <div className="adapters-tab__info">
                <div className="adapters-tab__name-row">
                  <span className="adapters-tab__name">{adapter.name}</span>
                  {isDetected && (
                    <Badge color="emerald" small>
                      detected
                    </Badge>
                  )}
                  <span className="adapters-tab__file">{adapter.file}</span>
                </div>
                <div className="adapters-tab__desc">{adapter.desc}</div>
              </div>

              <div className="adapters-tab__actions">
                {isDetected ? (
                  <>
                    <Button variant="secondary" size="sm">
                      <IconEye size={13} />
                      Preview
                    </Button>
                    <Button variant="primary" size="sm">
                      <IconRefresh size={13} />
                      Regenerate
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm">
                    Generate
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="adapters-tab__footer">
        Adapters are thin config files that point your AI coding tool to .dev/ — they reference the universal layer, never duplicate content.
      </p>
    </div>
  );
}

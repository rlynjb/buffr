"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { TextArea } from "@/components/ui/textarea";

interface StepRepoProps {
  repoName: string;
  repoVisibility: "public" | "private";
  repoDescription: string;
  onChange: (field: string, value: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

function isValidRepoName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) && name.length > 0;
}

export function StepRepo({
  repoName,
  repoVisibility,
  repoDescription,
  onChange,
  onContinue,
  onBack,
}: StepRepoProps) {
  const nameValid = isValidRepoName(repoName);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">
          Repository Setup
        </h1>
        <p className="text-sm text-muted">
          Configure your GitHub repository. The repo will be created in the
          next step.
        </p>
      </div>

      <Input
        label="Repository Name"
        value={repoName}
        onChange={(e) =>
          onChange("repoName", e.target.value.toLowerCase().replace(/\s+/g, "-"))
        }
        error={repoName && !nameValid ? "Invalid repo name" : undefined}
        placeholder="my-project"
      />

      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-foreground">
          Visibility
        </label>
        <Toggle
          options={["Private", "Public"]}
          value={repoVisibility === "private" ? "Private" : "Public"}
          onChange={(v) =>
            onChange(
              "repoVisibility",
              v === "Private" ? "private" : "public"
            )
          }
        />
      </div>

      <TextArea
        label="Description"
        value={repoDescription}
        onChange={(e) => onChange("repoDescription", e.target.value)}
        placeholder="A short description for your GitHub repo"
        rows={2}
      />

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={!nameValid}>
          Continue to Deploy
        </Button>
      </div>
    </div>
  );
}

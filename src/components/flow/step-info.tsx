"use client";

import { TextArea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface StepInfoProps {
  description: string;
  constraints: string;
  goals: string;
  onChange: (field: string, value: string) => void;
  onSubmit: () => void;
  loading: boolean;
}

export function StepInfo({
  description,
  constraints,
  goals,
  onChange,
  onSubmit,
  loading,
}: StepInfoProps) {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">
          Describe your project
        </h1>
        <p className="text-sm text-muted">
          Tell us what you want to build. buffr will generate a plan, create
          your repo, and deploy it.
        </p>
      </div>

      <TextArea
        label="Project Description"
        value={description}
        onChange={(e) => onChange("description", e.target.value)}
        placeholder="A recipe sharing app where users can upload, search, and save recipes with ingredient-based filtering"
        rows={4}
      />

      <TextArea
        label="Constraints"
        value={constraints}
        onChange={(e) => onChange("constraints", e.target.value)}
        placeholder="Solo developer, must ship MVP in 2 weeks, no paid services beyond hosting, mobile-friendly"
        rows={3}
      />

      <TextArea
        label="Goals"
        value={goals}
        onChange={(e) => onChange("goals", e.target.value)}
        placeholder="Launch on Product Hunt, get 100 users in first month, monetize with premium recipes"
        rows={3}
      />

      <Button
        onClick={onSubmit}
        loading={loading}
        disabled={!description.trim()}
        size="lg"
      >
        Generate Plan
      </Button>
    </div>
  );
}

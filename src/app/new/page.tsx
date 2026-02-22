"use client";

import { useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { StepIndicator } from "@/components/flow/step-indicator";
import { StepInfo } from "@/components/flow/step-info";
import { StepPlan } from "@/components/flow/step-plan";
import { StepRepo } from "@/components/flow/step-repo";
import { StepDeploy } from "@/components/flow/step-deploy";
import { flowReducer, initialFlowState } from "@/lib/flow-state";
import { useProvider } from "@/context/provider-context";
import { useNotification } from "@/components/ui/notification";
import { generatePlan } from "@/lib/api";
import type { ProjectPlan } from "@/lib/types";

export default function NewProjectPage() {
  const router = useRouter();
  const { selected: provider } = useProvider();
  const { notify } = useNotification();
  const [state, dispatch] = useReducer(flowReducer, initialFlowState);
  const [generating, setGenerating] = useState(false);

  async function handleGeneratePlan(existingPlan?: ProjectPlan) {
    setGenerating(true);
    try {
      const result = await generatePlan({
        description: state.description,
        constraints: state.constraints,
        goals: state.goals,
        provider,
        existingPlan: existingPlan || undefined,
      });
      dispatch({ type: "SET_PLAN", plan: result.plan });
      dispatch({ type: "SET_STEP", step: 2 });
    } catch (err) {
      notify(
        "error",
        err instanceof Error ? err.message : "Failed to generate plan"
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleRegenerate() {
    dispatch({ type: "INCREMENT_REGENERATE" });
    await handleGeneratePlan(state.plan!);
  }

  return (
    <div>
      <StepIndicator current={state.step} />

      {state.step === 1 && (
        <StepInfo
          description={state.description}
          constraints={state.constraints}
          goals={state.goals}
          onChange={(field, value) =>
            dispatch({ type: "SET_FIELD", field: field as keyof typeof state, value })
          }
          onSubmit={() => handleGeneratePlan()}
          loading={generating}
        />
      )}

      {state.step === 2 && state.plan && (
        <StepPlan
          plan={state.plan}
          selectedFiles={state.selectedFiles}
          regenerateCount={state.regenerateCount}
          onUpdatePlan={(field, value) => {
            dispatch({
              type: "SET_PLAN",
              plan: { ...state.plan!, [field]: value },
            });
          }}
          onUpdateFeature={(index, updates) =>
            dispatch({ type: "UPDATE_FEATURE", index, updates })
          }
          onMoveFeature={(index, toPhase) =>
            dispatch({ type: "MOVE_FEATURE", index, toPhase })
          }
          onToggleFile={(file) => dispatch({ type: "TOGGLE_FILE", file })}
          onRegenerate={handleRegenerate}
          onContinue={() => dispatch({ type: "SET_STEP", step: 3 })}
          onBack={() => dispatch({ type: "SET_STEP", step: 1 })}
          regenerating={generating}
        />
      )}

      {state.step === 3 && (
        <StepRepo
          repoName={state.repoName}
          repoVisibility={state.repoVisibility}
          repoDescription={state.repoDescription}
          onChange={(field, value) =>
            dispatch({ type: "SET_FIELD", field: field as keyof typeof state, value })
          }
          onContinue={() => dispatch({ type: "SET_STEP", step: 4 })}
          onBack={() => dispatch({ type: "SET_STEP", step: 2 })}
        />
      )}

      {state.step === 4 && (
        <StepDeploy
          state={state}
          onComplete={(projectId) =>
            router.push(`/project/${projectId}`)
          }
          onBack={() => dispatch({ type: "SET_STEP", step: 3 })}
          onChange={(field, value) => {
            if (field === "projectName") {
              dispatch({
                type: "SET_PLAN",
                plan: { ...state.plan!, projectName: value },
              });
            } else {
              dispatch({
                type: "SET_FIELD",
                field: field as keyof typeof state,
                value,
              });
            }
          }}
        />
      )}
    </div>
  );
}

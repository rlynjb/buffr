import type { ProjectPlan, PlanFeature } from "./types";

export type FlowStep = 1 | 2 | 3 | 4;

export interface FlowState {
  step: FlowStep;
  // Step 1
  description: string;
  constraints: string;
  goals: string;
  // Step 2
  plan: ProjectPlan | null;
  selectedFiles: string[];
  regenerateCount: number;
  // Step 3
  repoName: string;
  repoVisibility: "public" | "private";
  repoDescription: string;
  // Step 4 results
  githubRepo: string | null;
  repoUrl: string | null;
  netlifySiteId: string | null;
  netlifySiteUrl: string | null;
  createdFiles: string[];
}

export type FlowAction =
  | { type: "SET_STEP"; step: FlowStep }
  | { type: "SET_FIELD"; field: keyof FlowState; value: unknown }
  | { type: "SET_PLAN"; plan: ProjectPlan }
  | { type: "UPDATE_FEATURE"; index: number; updates: Partial<PlanFeature> }
  | { type: "MOVE_FEATURE"; index: number; toPhase: 1 | 2 }
  | { type: "SET_SELECTED_FILES"; files: string[] }
  | { type: "TOGGLE_FILE"; file: string }
  | { type: "INCREMENT_REGENERATE" }
  | {
      type: "SET_DEPLOY_RESULT";
      githubRepo: string;
      repoUrl: string;
      netlifySiteId: string;
      netlifySiteUrl: string;
      createdFiles: string[];
    };

export const initialFlowState: FlowState = {
  step: 1,
  description: "",
  constraints: "",
  goals: "",
  plan: null,
  selectedFiles: [
    "AI_RULES.md",
    "README.md",
    "ARCHITECTURE.md",
    "DEPLOYMENT.md",
    ".eslintrc.json",
    ".prettierrc",
    ".env.example",
    ".gitignore",
    ".editorconfig",
    "CONTRIBUTING.md",
    "LICENSE",
  ],
  regenerateCount: 0,
  repoName: "",
  repoVisibility: "public",
  repoDescription: "",
  githubRepo: null,
  repoUrl: null,
  netlifySiteId: null,
  netlifySiteUrl: null,
  createdFiles: [],
};

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };

    case "SET_FIELD":
      return { ...state, [action.field]: action.value };

    case "SET_PLAN": {
      const plan = action.plan;
      return {
        ...state,
        plan,
        repoName: plan.projectName,
        repoDescription: (plan.description || state.description).substring(0, 350),
      };
    }

    case "UPDATE_FEATURE": {
      if (!state.plan) return state;
      const features = [...state.plan.features];
      features[action.index] = { ...features[action.index], ...action.updates };
      return { ...state, plan: { ...state.plan, features } };
    }

    case "MOVE_FEATURE": {
      if (!state.plan) return state;
      const features = [...state.plan.features];
      features[action.index] = {
        ...features[action.index],
        phase: action.toPhase,
      };
      return { ...state, plan: { ...state.plan, features } };
    }

    case "SET_SELECTED_FILES":
      return { ...state, selectedFiles: action.files };

    case "TOGGLE_FILE": {
      const files = state.selectedFiles.includes(action.file)
        ? state.selectedFiles.filter((f) => f !== action.file)
        : [...state.selectedFiles, action.file];
      return { ...state, selectedFiles: files };
    }

    case "INCREMENT_REGENERATE":
      return { ...state, regenerateCount: state.regenerateCount + 1 };

    case "SET_DEPLOY_RESULT":
      return {
        ...state,
        githubRepo: action.githubRepo,
        repoUrl: action.repoUrl,
        netlifySiteId: action.netlifySiteId,
        netlifySiteUrl: action.netlifySiteUrl,
        createdFiles: action.createdFiles,
      };

    default:
      return state;
  }
}

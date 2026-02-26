export const SUMMARIZE_SYSTEM_PROMPT = `You are a concise technical summarizer. Given a list of activity items from a coding session, produce 3-5 bullet points summarizing what happened. Each bullet should be a single sentence. Focus on concrete outcomes, not process. Return valid JSON: { "bullets": ["...", "..."] }`;

export function buildSummarizePrompt(
  activityItems: Array<{ title: string; source: string; timestamp?: string }>,
): string {
  const lines = activityItems
    .map((item) => `- [${item.source}] ${item.title}${item.timestamp ? ` (${item.timestamp})` : ""}`)
    .join("\n");
  return `Summarize these session activities:\n\n${lines}`;
}

export const INTENT_SYSTEM_PROMPT = `You are a project intent detector. Given a session goal, what changed, and the project phase, identify the primary intent in 2-5 words (e.g. "authentication feature", "bug fix for checkout", "CI/CD setup"). Return valid JSON: { "intent": "..." }`;

export function buildIntentPrompt(
  goal: string,
  whatChanged: string,
  projectPhase: string,
): string {
  return `Goal: ${goal}\nWhat changed: ${whatChanged}\nProject phase: ${projectPhase}\n\nWhat is the primary intent of this session?`;
}

export const SUGGEST_SYSTEM_PROMPT = `You are a developer productivity assistant. Given the context of a coding session, suggest the single most impactful next step. Be specific and actionable (e.g. "Write unit tests for the auth middleware" not "Continue working"). Return valid JSON: { "suggestedNextStep": "..." }`;

export function buildSuggestPrompt(
  goal: string,
  whatChanged: string,
  currentNextStep: string,
  projectContext: string,
  openItems: string,
): string {
  let prompt = `Session goal: ${goal}\nWhat changed: ${whatChanged}`;
  if (currentNextStep) prompt += `\nCurrent next step (user-provided): ${currentNextStep}`;
  if (projectContext) prompt += `\nProject context: ${projectContext}`;
  if (openItems) prompt += `\nOpen items:\n${openItems}`;
  prompt += "\n\nSuggest the best next step:";
  return prompt;
}

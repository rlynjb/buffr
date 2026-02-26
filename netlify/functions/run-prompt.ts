import type { Context } from "@netlify/functions";
import { getLLM } from "./lib/ai/provider";
import { createPromptChain } from "./lib/ai/chains/prompt-chain";
import { resolveToolTokens } from "./lib/resolve-tools";
import { getPrompt, savePrompt } from "./lib/storage/prompts";
import { getProject } from "./lib/storage/projects";
import { listSessionsByProject } from "./lib/storage/sessions";
import { listToolsByIntegration } from "./lib/tools/registry";
import { json, errorResponse, classifyError } from "./lib/responses";

// Import tool registrations to ensure tools are available
import { registerGitHubTools } from "./lib/tools/github";
import { registerNotionTools } from "./lib/tools/notion";
import { registerJiraTools } from "./lib/tools/jira";

registerGitHubTools();
registerNotionTools();
registerJiraTools();

/**
 * Simple synchronous variable resolution (mirrors src/lib/resolve-prompt.ts).
 * This avoids importing from src/ which may have different module resolution.
 */
function resolveVariables(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key: string) => {
    return vars[key] ?? "";
  });
}

export default async function handler(req: Request, _context: Context) {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = await req.json();
    const { promptId, projectId, provider } = body as {
      promptId: string;
      projectId?: string;
      provider?: string;
    };

    if (!promptId) return errorResponse("promptId is required", 400);

    const prompt = await getPrompt(promptId);
    if (!prompt) return errorResponse("Prompt not found", 404);

    // Build variable context
    const vars: Record<string, string> = {};
    let toolDefaultInput: Record<string, unknown> = {};

    if (projectId) {
      const project = await getProject(projectId);
      if (project) {
        vars["project.name"] = project.name;
        vars["project.stack"] = project.stack;
        vars["project.description"] = project.description;
        vars["project.phase"] = project.phase;
        vars["project.goals"] = project.goals;
        vars["project.constraints"] = project.constraints;

        if (project.githubRepo) {
          const [owner, repo] = project.githubRepo.split("/");
          toolDefaultInput = { owner, repo };
        }

        // Load last session
        const sessions = await listSessionsByProject(projectId);
        if (sessions.length > 0) {
          const last = sessions[0];
          vars["lastSession.goal"] = last.goal;
          vars["lastSession.nextStep"] = last.nextStep;
          vars["lastSession.blockers"] = last.blockers || "";
        }
      }
    }

    // Step 1: Resolve {{variable}} tokens
    let resolved = resolveVariables(prompt.body, vars);

    // Step 2: Resolve {{tool:...}} tokens (async, server-side only)
    resolved = await resolveToolTokens(resolved, toolDefaultInput);

    // Step 3: Run through LLM
    const llm = getLLM(provider || "anthropic");
    const chain = createPromptChain(llm);

    // Get available tool names for suggested actions
    const toolNames = [
      ...listToolsByIntegration("github"),
      ...listToolsByIntegration("notion"),
      ...listToolsByIntegration("jira"),
    ].map((t) => t.name);

    const result = await chain.invoke({
      resolvedPrompt: resolved,
      availableTools: toolNames,
    });

    // Increment usage count
    prompt.usageCount = (prompt.usageCount || 0) + 1;
    await savePrompt(prompt);

    return json(result);
  } catch (err) {
    console.error("run-prompt function error:", err);
    const { message, status } = classifyError(err, "Failed to run prompt");
    return errorResponse(message, status);
  }
}

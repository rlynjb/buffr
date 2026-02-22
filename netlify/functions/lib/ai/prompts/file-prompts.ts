export function getFilePrompt(
  fileType: string,
  context: {
    projectName: string;
    description: string;
    stack: string;
    features: string[];
    constraints: string;
    goals: string;
  }
): string {
  const base = `Project: ${context.projectName}
Description: ${context.description}
Tech Stack: ${context.stack}
Features: ${context.features.join(", ")}
${context.constraints ? `Constraints: ${context.constraints}` : ""}
${context.goals ? `Goals: ${context.goals}` : ""}`;

  const prompts: Record<string, string> = {
    "AI_RULES.md": `${base}

Generate an AI_RULES.md file for this project. Include:
- System prompt rules and guidelines
- Input validation rules
- Output validation rules
- Rate limiting defaults
- Error handling patterns
- Content safety baseline
- Testing checklist
Tailor it to the project's specific needs. Output ONLY the file content, no code fences.`,

    "README.md": `${base}

Generate a README.md for this project. Include:
- Project name and description
- Tech stack overview
- Setup instructions (prerequisites, install, env vars)
- Folder structure
- How to run locally
- How to deploy
Output ONLY the file content, no code fences.`,

    "ARCHITECTURE.md": `${base}

Generate an ARCHITECTURE.md for this project. Include:
- System overview
- Tech stack rationale
- Folder structure explanation
- Data flow description
- Key design decisions
- API structure (if applicable)
Output ONLY the file content, no code fences.`,

    "DEPLOYMENT.md": `${base}

Generate a DEPLOYMENT.md for this project. Include:
- Prerequisites
- Environment variables needed
- Build commands
- Deploy steps (specific to the stack)
- CI/CD notes
- Rollback instructions
Output ONLY the file content, no code fences.`,

    ".eslintrc.json": `${base}

Generate an .eslintrc.json config file for this project. Use sensible defaults for the tech stack. Include relevant plugins (e.g. eslint-plugin-react for React, @typescript-eslint for TypeScript). Output ONLY valid JSON, no code fences.`,

    ".prettierrc": `${base}

Generate a .prettierrc config file for this project. Use sensible defaults: 2 spaces, semicolons, double quotes, trailing commas. Output ONLY valid JSON, no code fences.`,

    ".env.example": `${base}

Generate a .env.example file for this project. Include common variables for the tech stack plus any project-specific variables inferred from the description. Use comments to explain each variable. Output ONLY the file content, no code fences.`,

    ".gitignore": `${base}

Generate a .gitignore file for this project. Include proper ignores for the tech stack (node_modules, .env, build outputs, IDE files, OS files, etc). Output ONLY the file content, no code fences.`,

    ".editorconfig": `${base}

Generate an .editorconfig file. Include: indent_style = space, indent_size = 2, charset = utf-8, end_of_line = lf, trim_trailing_whitespace = true, insert_final_newline = true. Add language-specific sections as appropriate. Output ONLY the file content, no code fences.`,

    "CONTRIBUTING.md": `${base}

Generate a CONTRIBUTING.md for this project. Include:
- How to set up the dev environment
- Branch naming conventions
- Commit message format
- PR process
- Code style notes
Output ONLY the file content, no code fences.`,

    LICENSE: `Generate an MIT License file with the year 2025 and the project name "${context.projectName}". Output ONLY the license text, no code fences.`,
  };

  return prompts[fileType] || `Generate the content for ${fileType} for the project described above. Output ONLY the file content.`;
}

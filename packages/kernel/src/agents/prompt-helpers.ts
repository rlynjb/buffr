// packages/kernel/src/agents/prompt-helpers.ts

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

export type InjectProfileOptions = {
  position?: 'start' | 'end';
  heading?: string;
};

export function injectProfile(systemTemplate: string, profileText: string, opts?: InjectProfileOptions): string {
  const position = opts?.position ?? 'start';
  const heading = opts?.heading;
  const block = heading ? `${heading}\n${profileText}` : profileText;
  return position === 'end' ? `${systemTemplate}\n\n${block}` : `${block}\n\n${systemTemplate}`;
}

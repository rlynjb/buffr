/**
 * A reference prompt has no template tokens (no {{ }} interpolation).
 */
export function isReferencePrompt(body: string): boolean {
  return !body.includes("{{");
}

/**
 * Split prompt body on {{...}} tokens and wrap each in a <span>
 * with the appropriate CSS class for tool vs. variable tokens.
 */
export function renderPromptTokens(
  body: string,
  toolClass: string,
  variableClass: string,
) {
  return body.split(/({{.*?}})/).map((part, i) =>
    part.startsWith("{{tool:") ? (
      <span key={i} className={toolClass}>{part}</span>
    ) : part.startsWith("{{") ? (
      <span key={i} className={variableClass}>{part}</span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

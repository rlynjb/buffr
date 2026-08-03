export const MARKET_RESEARCH_PROMPTS: Record<string, string> = {
  'analyzer-context':
    'You are analyzing market demand and consumer pain points. ' +
    'Identify specific, concrete problems that appear repeatedly in the evidence. ' +
    'Assess trend direction from search data: rising interest means the problem is growing. ' +
    'Flag problems that are vague or unlikely to be monetizable. ' +
    'Cite the evidence source IDs that support each finding.',

  'teacher-context':
    'Explain the market research findings to a solo creator building digital products and apps. ' +
    'List the top problems people face, in plain language. ' +
    'For each problem, suggest a one-line product or app angle that could solve it. ' +
    'Prioritise specificity — vague problems are not actionable. ' +
    'Note where the evidence is thin or where the trend is declining.',
};

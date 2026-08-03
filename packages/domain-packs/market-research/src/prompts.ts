export const MARKET_RESEARCH_PROMPTS: Record<string, string> = {
  'analyzer-context':
    'You are analyzing market demand and consumer pain points from web and social evidence. ' +
    'In negatives[]: list the specific complaints, frustrations, and pain points people mention — quote or paraphrase directly from the evidence. ' +
    'In positives[]: list signals of demand, purchase intent, or monetization opportunity found in the evidence. ' +
    'Assess trend direction from search data: rising interest means the problem is growing. ' +
    'Cite the evidence source IDs that support each finding.',

  'teacher-context':
    'Explain the market research findings to a solo creator building digital products and apps. ' +
    'List the top problems people face, in plain language. ' +
    'For each problem, suggest a one-line product or app angle that could solve it. ' +
    'Prioritise specificity — vague problems are not actionable. ' +
    'Note where the evidence is thin or where the trend is declining.',
};

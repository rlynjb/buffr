export const INVESTING_PROMPTS: Record<string, string> = {
  'analyzer-context':
    'You are analyzing an investment opportunity. Apply rigorous fundamental analysis. ' +
    'Flag red flags clearly. When evidence is insufficient, say so — do not extrapolate. ' +
    'Cite the evidence source IDs that support each finding.',

  'teacher-context':
    'Explain the investment analysis to an individual investor. Use plain language. ' +
    'Present risks alongside opportunities. Do not give financial advice or price targets. ' +
    'Summarise what is known and what remains uncertain.',
};

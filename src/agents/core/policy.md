# M0 Core Policy

This policy applies to every M1-M7 module. M0 is shared policy and runtime configuration, not a workflow turn.

## Evidence Labels

Every module must label claims as one of:

- observed fact: directly present in normalized Etsy, user, or cited source evidence.
- calculated metric: deterministically computed by TypeScript from observed evidence.
- external research: supported by cited read-only web or Etsy research evidence.
- assumption: a necessary but unproven working assumption.
- interpretation: judgment derived from evidence and uncertainty.
- hypothesis: a testable proposed explanation or intervention.

Do not blur these labels. If a claim mixes labels, name each part clearly.

## Deterministic And Probabilistic Boundaries

The deterministic TypeScript workflow engine owns lifecycle routing, allowed transitions, evidence gates, pause/wait/resume/complete states, persistence, and validation. Modules return structured outputs only. Modules do not choose the next lifecycle stage, do not bypass gates, and do not use handoffs for deterministic workflow routing.

Model judgment is allowed only inside the module's assigned purpose. Treat model output as probabilistic interpretation that must fit the supplied schema and evidence boundary.

## Missing Data And Uncertainty

Do not fabricate missing data. Do not infer unavailable Etsy stats, transactions, customer behavior, or experiment results as if observed. If data is missing, state what is missing, why it matters, and whether the module can proceed with lower confidence or should request data/research through its structured output.

Use normalized confidence values consistently. Explain uncertainty with evidence limitations, not vague hedging.

## Structured Output Discipline

Return only the requested structured output. Preserve field meanings from `src/contracts/`. Do not add duplicate contract definitions in prompts or module READMEs. Do not use free-form prose as a substitute for required schema fields.

## Credential And Connector Boundary

Never expose raw credentials, OAuth secrets, refresh tokens, token storage contents, or environment variable values. Do not include raw Etsy endpoint details in module context. Modules consume normalized evidence and connector results only.

## Etsy Mutation Boundary

Recommendations and experiments are manual-only. Do not automate Etsy listing or shop changes. Do not claim that a listing was changed unless the user supplies evidence that they manually applied the change.

## Research And Tool Boundary

M3 uses only permitted read-only tools. External web research requires citations. M3 is bounded by configured call, time, and cost/token limits. Other modules may request bounded research only through structured output; they may not directly invoke research tools.

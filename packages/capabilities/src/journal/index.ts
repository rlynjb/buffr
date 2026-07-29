import type { AgentContext, AgentResult, Capability, DecisionJournalEntry } from '@buffr/contracts';

export type { DecisionJournalEntry } from '@buffr/contracts';

export type JournalInput = {
  subject: { type: string; id: string; description: string };
  domain: string;
  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;
  confidence?: number;
  assumptions?: string[];
  risks?: string[];
  evidenceIds?: string[];
  reviewAt?: string;
};

export type JournalOutput = {
  entry: DecisionJournalEntry;
};

export class Journal implements Capability<JournalInput, JournalOutput> {
  readonly name = 'journal';
  readonly version = '1.0.0';

  async execute(input: JournalInput, context: AgentContext): Promise<AgentResult<JournalOutput>> {
    const confidence = input.confidence ?? 0.5;
    const entry: DecisionJournalEntry = {
      id: crypto.randomUUID(),
      userId: context.userId,
      workspaceId: context.workspaceId,
      domain: input.domain,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      createdAt: context.now,
      decision: input.decision,
      thesis: input.thesis,
      expectedOutcome: input.expectedOutcome,
      ...(input.timeHorizon !== undefined ? { timeHorizon: input.timeHorizon } : {}),
      confidence,
      assumptions: input.assumptions ?? [],
      risks: input.risks ?? [],
      evidenceIds: input.evidenceIds ?? [],
      status: 'open',
      ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
    };

    return {
      data: { entry },
      confidence,
      evidence: [],
      assumptions: entry.assumptions,
      warnings: [],
      traceId: context.traceId,
    };
  }
}

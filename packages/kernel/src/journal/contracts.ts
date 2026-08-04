// packages/kernel/src/journal/contracts.ts

export type JournalStatus = 'open' | 'review-due' | 'resolved' | 'discarded';
export type Disposition = 'successful' | 'unsuccessful' | 'inconclusive';

export type PredictionRecord = {
  expectedScore: number;
  expectedDimension: string;
  confidence: number;
};

export type AssessmentRecord = {
  score: number;
  confidence: number;
};

export type JournalEntry = {
  id: string;
  userId: string;
  workspaceId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  kind: 'hypothesis' | 'decision';
  claim: string;
  evidenceIds: string[];
  createdAt: string;
  status: JournalStatus;
  // decision-only:
  stake?: string;
  resolutionCondition?: string;
  reviewAt?: string;
  prediction?: PredictionRecord;
  assessment?: AssessmentRecord;
  // resolved-only:
  disposition?: Disposition;
  note?: string;
  resolvedAt?: string;
};

type JournalEntryCommon = {
  userId: string;
  workspaceId: string;
  domain: string;
  subjectType: string;
  subjectId: string;
  claim: string;
  evidenceIds: string[];
};

export type NewJournalEntry =
  | ({ kind: 'hypothesis' } & JournalEntryCommon)
  | ({ kind: 'decision' } & JournalEntryCommon & {
      stake: string;
      resolutionCondition: string;
      reviewAt: string;
      prediction: PredictionRecord;
      assessment: AssessmentRecord;
    });

/**
 * listDue() is also where the open -> review-due transition happens: any
 * decision with status 'open' and reviewAt <= now is flipped to 'review-due'
 * as a side effect of being listed, then returned. Both implementations
 * must do this identically.
 */
export type JournalStore = {
  create(entry: NewJournalEntry, now: string): Promise<JournalEntry>;
  listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]>;
  snooze(id: string, reviewAt: string): Promise<JournalEntry>;
  resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry>;
};

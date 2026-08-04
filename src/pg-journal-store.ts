import pg from 'pg';
import type { JournalStore, JournalEntry, NewJournalEntry, Disposition } from '@buffr/kernel';

export type PgJournalStoreOptions = {
  pool: pg.Pool;
  appId?: string;
};

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    workspaceId: row.workspace_id as string,
    domain: row.domain as string,
    subjectType: row.subject_type as string,
    subjectId: row.subject_id as string,
    kind: row.kind as 'hypothesis' | 'decision',
    claim: row.claim as string,
    evidenceIds: row.evidence_ids as string[],
    createdAt: (row.created_at as Date).toISOString(),
    status: row.status as JournalEntry['status'],
    stake: (row.stake as string | null) ?? undefined,
    resolutionCondition: (row.resolution_condition as string | null) ?? undefined,
    reviewAt: row.review_at ? (row.review_at as Date).toISOString() : undefined,
    prediction: row.predicted_score != null
      ? {
          expectedScore: Number(row.predicted_score),
          expectedDimension: row.predicted_dimension as string,
          confidence: Number(row.predicted_confidence),
        }
      : undefined,
    assessment: row.assessed_score != null
      ? { score: Number(row.assessed_score), confidence: Number(row.assessed_confidence) }
      : undefined,
    disposition: (row.disposition as Disposition | null) ?? undefined,
    note: (row.note as string | null) ?? undefined,
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : undefined,
  };
}

export class PgJournalStore implements JournalStore {
  private readonly pool: pg.Pool;
  private readonly appId: string;

  constructor(opts: PgJournalStoreOptions) {
    this.pool = opts.pool;
    this.appId = opts.appId ?? 'laptop';
  }

  async create(entry: NewJournalEntry, now: string): Promise<JournalEntry> {
    const decisionFields = entry.kind === 'decision'
      ? {
          stake: entry.stake,
          resolution_condition: entry.resolutionCondition,
          review_at: entry.reviewAt,
          predicted_score: entry.prediction.expectedScore,
          predicted_dimension: entry.prediction.expectedDimension,
          predicted_confidence: entry.prediction.confidence,
          assessed_score: entry.assessment.score,
          assessed_confidence: entry.assessment.confidence,
        }
      : {
          stake: null, resolution_condition: null, review_at: null,
          predicted_score: null, predicted_dimension: null, predicted_confidence: null,
          assessed_score: null, assessed_confidence: null,
        };

    const { rows } = await this.pool.query(
      `insert into agents.decisions
        (app_id, user_id, workspace_id, domain, subject_type, subject_id, kind, claim, evidence_ids, created_at,
         status, stake, resolution_condition, review_at, predicted_score, predicted_dimension, predicted_confidence,
         assessed_score, assessed_confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'open',$11,$12,$13,$14,$15,$16,$17,$18)
       returning *`,
      [
        this.appId, entry.userId, entry.workspaceId, entry.domain, entry.subjectType, entry.subjectId,
        entry.kind, entry.claim, JSON.stringify(entry.evidenceIds), now,
        decisionFields.stake, decisionFields.resolution_condition, decisionFields.review_at,
        decisionFields.predicted_score, decisionFields.predicted_dimension, decisionFields.predicted_confidence,
        decisionFields.assessed_score, decisionFields.assessed_confidence,
      ],
    );
    return rowToEntry(rows[0]);
  }

  async listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]> {
    await this.pool.query(
      `update agents.decisions set status = 'review-due'
       where app_id = $1 and user_id = $2 and workspace_id = $3
         and kind = 'decision' and status = 'open' and review_at <= $4`,
      [this.appId, userId, workspaceId, now],
    );
    const { rows } = await this.pool.query(
      `select * from agents.decisions
       where app_id = $1 and user_id = $2 and workspace_id = $3 and status = 'review-due'
       order by review_at asc`,
      [this.appId, userId, workspaceId],
    );
    return rows.map(rowToEntry);
  }

  async snooze(id: string, reviewAt: string): Promise<JournalEntry> {
    const { rows } = await this.pool.query(
      `update agents.decisions set status = 'open', review_at = $2 where id = $1 returning *`,
      [id, reviewAt],
    );
    return rowToEntry(rows[0]);
  }

  async resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry> {
    const { rows } = await this.pool.query(
      `update agents.decisions set status = 'resolved', disposition = $2, note = $3, resolved_at = $4 where id = $1 returning *`,
      [id, disposition, note, now],
    );
    return rowToEntry(rows[0]);
  }
}

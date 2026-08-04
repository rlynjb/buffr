// packages/kernel/src/journal/in-memory-journal-store.ts
import type { JournalStore, JournalEntry, NewJournalEntry, Disposition } from './contracts.js';

export class InMemoryJournalStore implements JournalStore {
  private readonly entries = new Map<string, JournalEntry>();
  private seq = 0;

  async create(entry: NewJournalEntry, now: string): Promise<JournalEntry> {
    const id = `journal-${++this.seq}`;
    const base = {
      id,
      userId: entry.userId,
      workspaceId: entry.workspaceId,
      domain: entry.domain,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      kind: entry.kind,
      claim: entry.claim,
      evidenceIds: entry.evidenceIds,
      createdAt: now,
      status: 'open' as const,
    };
    const full: JournalEntry = entry.kind === 'decision'
      ? {
          ...base,
          stake: entry.stake,
          resolutionCondition: entry.resolutionCondition,
          reviewAt: entry.reviewAt,
          prediction: entry.prediction,
          assessment: entry.assessment,
        }
      : base;
    this.entries.set(id, full);
    return full;
  }

  async listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]> {
    for (const e of this.entries.values()) {
      if (
        e.userId === userId &&
        e.workspaceId === workspaceId &&
        e.kind === 'decision' &&
        e.status === 'open' &&
        e.reviewAt &&
        e.reviewAt <= now
      ) {
        e.status = 'review-due';
      }
    }
    return [...this.entries.values()]
      .filter(e => e.userId === userId && e.workspaceId === workspaceId && e.status === 'review-due')
      .sort((a, b) => (a.reviewAt ?? '').localeCompare(b.reviewAt ?? ''));
  }

  async snooze(id: string, reviewAt: string): Promise<JournalEntry> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`journal entry not found: ${id}`);
    e.status = 'open';
    e.reviewAt = reviewAt;
    return e;
  }

  async resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`journal entry not found: ${id}`);
    e.status = 'resolved';
    e.disposition = disposition;
    e.note = note;
    e.resolvedAt = now;
    return e;
  }
}

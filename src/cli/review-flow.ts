import type { ChatSession } from '../session.js';
import type { JournalEntry, Disposition } from '@buffr/kernel';
import { parseDayCountOrDate } from './parse-review-date.js';

export type ReviewFlowStep = 'action' | 'snooze-date' | 'disposition' | 'note' | 'done';

export type ReviewFlowResult = {
  messages: string[];
  step: ReviewFlowStep;
};

export type ReviewFlow = {
  start(): Promise<ReviewFlowResult>;
  submit(input: string): Promise<ReviewFlowResult>;
};

function formatEntry(entry: JournalEntry): string {
  return [
    `${entry.subjectId} — staked: ${entry.stake}`,
    `Resolution condition: ${entry.resolutionCondition}`,
    `Predicted ${entry.prediction?.expectedScore} (${entry.prediction?.expectedDimension}) · buffr scored ${entry.assessment?.score?.toFixed(0)}`,
  ].join('\n');
}

const ACTION_PROMPT = 'keep / snooze / resolve — what do you want to do?';

function parseDisposition(input: string): Disposition | null {
  const v = input.trim().toLowerCase();
  if (v === 'successful' || v === 'unsuccessful' || v === 'inconclusive') return v;
  return null;
}

export function createReviewFlow(session: ChatSession): ReviewFlow {
  let due: JournalEntry[] = [];
  let index = 0;
  let step: ReviewFlowStep = 'action';
  let pendingDisposition: Disposition | null = null;

  function currentEntry(): JournalEntry {
    const e = due[index];
    if (!e) throw new Error('review flow: no current entry');
    return e;
  }

  function advance(message: string): ReviewFlowResult {
    index += 1;
    if (index >= due.length) {
      step = 'done';
      return { messages: [message, 'Review complete.'], step };
    }
    step = 'action';
    return { messages: [message, formatEntry(currentEntry()), ACTION_PROMPT], step };
  }

  return {
    async start(): Promise<ReviewFlowResult> {
      due = await session.listDueReviews();
      if (due.length === 0) {
        step = 'done';
        return { messages: ['Nothing due for review.'], step };
      }
      index = 0;
      step = 'action';
      return { messages: [formatEntry(currentEntry()), ACTION_PROMPT], step };
    },

    async submit(input: string): Promise<ReviewFlowResult> {
      if (due.length === 0) throw new Error('review flow: submit() called before start()');

      if (step === 'action') {
        const choice = input.trim().toLowerCase();
        if (choice === 'keep') {
          return advance('Kept open.');
        }
        if (choice === 'snooze') {
          step = 'snooze-date';
          return { messages: ['Snooze until when? (e.g. "14" for 14 days, or an ISO date)'], step };
        }
        if (choice === 'resolve') {
          step = 'disposition';
          return { messages: ['Disposition — successful / unsuccessful / inconclusive?'], step };
        }
        return { messages: [ACTION_PROMPT], step };
      }

      if (step === 'snooze-date') {
        const reviewAt = parseDayCountOrDate(input);
        if (!reviewAt) {
          return { messages: ['Could not parse that. Enter a number of days from now or an ISO date.'], step };
        }
        await session.snoozeReview(currentEntry().id, reviewAt);
        return advance(`Snoozed until ${reviewAt.slice(0, 10)}.`);
      }

      if (step === 'disposition') {
        const disposition = parseDisposition(input);
        if (!disposition) {
          return { messages: ['Enter one of: successful, unsuccessful, inconclusive.'], step };
        }
        pendingDisposition = disposition;
        step = 'note';
        return { messages: ['Any note? (or leave blank)'], step };
      }

      // step === 'note'
      await session.resolveReview(currentEntry().id, pendingDisposition!, input.trim());
      pendingDisposition = null;
      return advance('Resolved.');
    },
  };
}

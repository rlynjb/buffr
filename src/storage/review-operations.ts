import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  WorkflowEventSchema,
  parseWithSchema,
  type WorkflowEvent,
} from '../contracts/workflow.js';
import {
  MarketplaceVisibilityProfileSchema,
  ProductRefSchema,
  type MarketplaceVisibilityProfile,
} from '../contracts/marketplace-visibility.js';
import { UtcDateSchema } from '../contracts/metrics.js';
import { AppError } from '../core/errors.js';
import { assertNoCredentialKeys } from '../workflow/guards.js';

export type ReviewOperationEventRepository = {
  appendEvent(operationId: string, event: WorkflowEvent): Promise<void>;
  loadEvents(operationId: string): Promise<WorkflowEvent[]>;
};

export type JsonFileReviewOperationEventRepositoryOptions = {
  rootDir: string;
};

export class JsonFileReviewOperationEventRepository implements ReviewOperationEventRepository {
  private readonly rootDir: string;

  constructor(options: JsonFileReviewOperationEventRepositoryOptions) {
    this.rootDir = options.rootDir;
  }

  async appendEvent(operationId: string, event: WorkflowEvent): Promise<void> {
    const validEvent = parseWithSchema(WorkflowEventSchema, event, 'review operation event');
    assertNoCredentialKeys(validEvent);
    const events = await this.loadEvents(operationId);
    await writeAtomic(this.eventFilePath(operationId), `${[...events, validEvent].map((value) => JSON.stringify(value)).join('\n')}\n`);
  }

  async loadEvents(operationId: string): Promise<WorkflowEvent[]> {
    const validOperationId = parseOperationId(operationId);
    let raw: string;
    try {
      raw = await readFile(this.eventFilePath(validOperationId), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw new AppError('storage_failed', `Review operation events could not be read: ${validOperationId}`, { cause: error });
    }

    try {
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parseWithSchema(WorkflowEventSchema, JSON.parse(line), 'review operation event'));
    } catch (error) {
      throw new AppError('storage_failed', `Review operation events JSONL is corrupt: ${validOperationId}`, { cause: error });
    }
  }

  private eventFilePath(operationId: string): string {
    return join(this.rootDir, 'review-operations', encodeURIComponent(parseOperationId(operationId)), 'events.jsonl');
  }
}

export function marketplaceReviewOperationId(input: {
  profile: MarketplaceVisibilityProfile;
  productRef: string;
  through: string;
}): string {
  const profile = parseWithSchema(MarketplaceVisibilityProfileSchema, input.profile, 'marketplace review profile');
  const productRef = parseWithSchema(ProductRefSchema, input.productRef, 'marketplace review product reference');
  const through = parseWithSchema(UtcDateSchema, input.through, 'marketplace review through date');
  return `marketplace-review:${profile}:${productRef}:${through}`;
}

function parseOperationId(operationId: string): string {
  if (!/^marketplace-review:[a-z_]+:[a-z0-9]+(?:-[a-z0-9]+)*:\d{4}-\d{2}-\d{2}$/u.test(operationId)) {
    throw new AppError('validation_failed', 'Marketplace review operation id is invalid');
  }
  return operationId;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

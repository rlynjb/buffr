import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../core/errors.js';
import {
  WorkflowRunStateSchema,
  type WorkflowRunState,
  type WorkflowRunStateInput,
} from '../contracts/workflow.js';

export type RunRepository = {
  create(state: WorkflowRunStateInput): Promise<void>;
  load(runId: string): Promise<WorkflowRunState>;
  save(state: WorkflowRunStateInput): Promise<void>;
};

export type JsonFileRunRepositoryOptions = {
  rootDir: string;
};

export class JsonFileRunRepository implements RunRepository {
  private readonly rootDir: string;

  constructor(options: JsonFileRunRepositoryOptions) {
    this.rootDir = options.rootDir;
  }

  async create(state: WorkflowRunStateInput): Promise<void> {
    await this.writeRun(state);
  }

  async load(runId: string): Promise<WorkflowRunState> {
    const file = this.runFilePath(runId);
    let raw: string;

    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new AppError('storage_failed', `Workflow run not found: ${runId}`, { cause: error });
      }
      throw new AppError('storage_failed', `Workflow run could not be read: ${runId}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AppError('storage_failed', `Workflow run JSON is corrupt: ${runId}`, { cause: error });
    }

    return parseRunState(parsed, runId);
  }

  async save(state: WorkflowRunStateInput): Promise<void> {
    await this.writeRun(state);
  }

  private async writeRun(state: WorkflowRunStateInput): Promise<void> {
    const validState = parseRunState(state, state.runId);
    const runDir = this.runDirPath(validState.runId);
    const file = join(runDir, 'run.json');
    const tempFile = join(runDir, `run.json.${process.pid}.tmp`);
    const json = `${JSON.stringify(validState, null, 2)}\n`;

    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(tempFile, json, 'utf8');
      await rename(tempFile, file);
    } catch (error) {
      throw new AppError('storage_failed', `Workflow run could not be saved: ${validState.runId}`, {
        cause: error,
      });
    }
  }

  private runFilePath(runId: string): string {
    return join(this.runDirPath(runId), 'run.json');
  }

  private runDirPath(runId: string): string {
    assertSafeRunId(runId);
    return join(this.rootDir, runId);
  }
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new AppError('storage_failed', `Invalid workflow run id: ${runId}`);
  }
}

function parseRunState(value: unknown, runId: string): WorkflowRunState {
  const result = WorkflowRunStateSchema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', `workflow run ${runId} failed validation`, {
      cause: result.error,
    });
  }
  return result.data;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

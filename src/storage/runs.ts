import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../core/errors.js';
import {
  WorkflowRunStateSchema,
  type WorkflowRunState,
  type WorkflowRunStateInput,
} from '../contracts/workflow.js';
import { assertNoCredentialKeys } from '../workflow/guards.js';

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
    assertNoCredentialKeys(validState);
    const runDir = this.runDirPath(validState.runId);
    const file = join(runDir, 'run.json');
    const json = `${JSON.stringify(validState, null, 2)}\n`;

    try {
      await mkdir(runDir, { recursive: true });
      await writeAtomic(file, json);
      await this.writeArtifacts(runDir, validState);
    } catch (error) {
      throw new AppError('storage_failed', `Workflow run could not be saved: ${validState.runId}`, {
        cause: error,
      });
    }
  }

  private async writeArtifacts(runDir: string, state: WorkflowRunState): Promise<void> {
    if (state.evidenceSnapshots?.initial) {
      await writeJsonArtifact(join(runDir, 'evidence', 'initial.json'), state.evidenceSnapshots.initial);
    }

    if (state.evidenceSnapshots?.result) {
      await writeJsonArtifact(join(runDir, 'evidence', 'result.json'), state.evidenceSnapshots.result);
    }

    if (state.moduleOutputs.m6) {
      await writeJsonArtifact(join(runDir, 'experiment-plan.json'), state.moduleOutputs.m6);
    }

    if (state.events.length > 0) {
      const eventsJsonl = `${state.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
      await writeAtomic(join(runDir, 'events.jsonl'), eventsJsonl);
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

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempFile = `${path}.${process.pid}.tmp`;
  await writeFile(tempFile, value, 'utf8');
  await rename(tempFile, path);
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

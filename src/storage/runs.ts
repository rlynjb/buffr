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
    const validState = parseRunState(state, state.runId);
    assertNoCredentialKeys(validState);
    const runDir = this.runDirPath(validState.runId);

    try {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(runDir);
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new AppError('storage_failed', `Workflow run already exists: ${validState.runId}`, { cause: error });
      }
      throw new AppError('storage_failed', `Workflow run could not be created: ${validState.runId}`, { cause: error });
    }

    try {
      await this.writeRunFiles(runDir, validState);
    } catch (error) {
      throw new AppError('storage_failed', `Workflow run could not be saved: ${validState.runId}`, { cause: error });
    }
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
    try {
      await mkdir(runDir, { recursive: true });
      await this.writeRunFiles(runDir, validState);
    } catch (error) {
      throw new AppError('storage_failed', `Workflow run could not be saved: ${validState.runId}`, {
        cause: error,
      });
    }
  }

  private async writeRunFiles(runDir: string, state: WorkflowRunState): Promise<void> {
    await writeAtomic(join(runDir, 'run.json'), `${JSON.stringify(state, null, 2)}\n`);
    await this.writeArtifacts(runDir, state);
  }

  private async writeArtifacts(runDir: string, state: WorkflowRunState): Promise<void> {
    if (state.evidenceSnapshots?.initial) {
      await writeJsonArtifact(join(runDir, 'evidence', 'initial.json'), state.evidenceSnapshots.initial);
    }

    if (state.evidenceSnapshots?.result) {
      await writeJsonArtifact(join(runDir, 'evidence', 'result.json'), state.evidenceSnapshots.result);
    }

    if (state.moduleOutputs.m6) {
      await writeJsonArtifact(join(runDir, 'experiment-plan.json'), experimentPlanArtifact(state));
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

function experimentPlanArtifact(state: WorkflowRunState): Record<string, unknown> {
  const researchRefs = state.moduleOutputs.m3
    .map((output, m3Index) => ({
      m3Index,
      urls: [...new Set(
        output.evidence
          .filter((citation) => citation.source === 'web' && citation.url?.startsWith('https://'))
          .map((citation) => citation.url!),
      )].sort(),
    }))
    .filter((reference) => reference.urls.length > 0);

  return {
    metadata: {
      artifactKind: 'experiment_plan',
      runId: state.runId,
      workflowKind: state.workflowKind,
      subjectRef: state.subjectRef,
      status: state.status,
      stage: state.stage,
      evidenceDate: evidenceDateFromSubjectRef(state.subjectRef),
      generatedAt: state.updatedAt,
      runCreatedAt: state.createdAt,
      evidenceRefs: state.evidenceRefs,
      ...(researchRefs.length > 0 ? { researchRefs } : {}),
    },
    ...state.moduleOutputs.m6,
  };
}

function evidenceDateFromSubjectRef(subjectRef: string | undefined): string | undefined {
  const match = subjectRef?.match(/(?:^|:)(\d{4}-\d{2}-\d{2})$/);
  return match?.[1];
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

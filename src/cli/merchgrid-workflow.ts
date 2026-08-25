import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAiAgentRunner } from '../agents/runner.js';
import { createMerchGridModuleExecutor } from '../agents/merchgrid/modules.js';
import { AppError } from '../core/errors.js';
import { loadLocalEnvironment } from '../core/local-env.js';
import { JsonFileMerchGridReviewArtifactRepository } from '../jobs/merchgrid-source-pack.js';
import { JsonFileRunRepository, type RunRepository } from '../storage/runs.js';
import { createWorkflowEngine, type WorkflowEngine } from '../workflow/engine.js';
import { createMerchGridWorkflowService, type MerchGridWorkflowService } from '../workflow/merchgrid-profile.js';

export type MerchGridWorkflowCliDependencies = { service: MerchGridWorkflowService; engine: WorkflowEngine; now?: () => Date };

export async function runMerchGridWorkflowCli(input: {
  args: readonly string[];
  dependencies: MerchGridWorkflowCliDependencies;
  writeLine: (line: string) => void;
}): Promise<void> {
  const [command, ...options] = input.args;

  if (command === 'daily-investigate') {
    assertOptions(options, ['--date'], ['--run-id']);
    const date = option(options, '--date');
    const runId = optionalOption(options, '--run-id') ?? defaultMerchGridRunId('daily', date, input.dependencies.now?.() ?? new Date());
    const result = await input.dependencies.service.startDailyInvestigation({ runId, date });
    if ('outcome' in result) return input.writeLine(`status: ${result.outcome}`);
    return printRun(input.writeLine, result);
  }
  if (command === 'weekly-recommend') {
    assertOptions(options, ['--through'], ['--run-id']);
    const through = option(options, '--through');
    const runId = optionalOption(options, '--run-id') ?? defaultMerchGridRunId('weekly', through, input.dependencies.now?.() ?? new Date());
    let state = await input.dependencies.service.startWeeklyRecommendation({ runId, through });
    while (['m1_context', 'm2_metrics_initial', 'm4_diagnosis', 'm5_hypothesis', 'm6_test_plan'].includes(state.stage)) {
      state = await input.dependencies.engine.step(runId);
    }
    return printRun(input.writeLine, state);
  }
  if (command === 'approve') {
    assertExactOptions(options, ['--run-id']);
    return printRun(input.writeLine, await input.dependencies.engine.approveExperiment(option(options, '--run-id')));
  }
  if (command === 'record-result') {
    assertExactOptions(options, ['--through', '--run-id']);
    const runId = option(options, '--run-id');
    let state = await input.dependencies.service.supplyWeeklyResult({ runId, through: option(options, '--through') });
    while (['m2_metrics_results', 'm7_learning'].includes(state.stage)) state = await input.dependencies.engine.step(runId);
    return printRun(input.writeLine, state);
  }
  throw new AppError('validation_failed', 'Expected daily-investigate, weekly-recommend, approve, or record-result command');
}

export function createMerchGridWorkflowDependencies(env: NodeJS.ProcessEnv = loadLocalEnvironment()): MerchGridWorkflowCliDependencies {
  const dataDir = required(env, 'MERCHGRID_METRICS_DATA_DIR');
  const runs: RunRepository = new JsonFileRunRepository({ rootDir: join(dataDir, 'workflow-runs') });
  const engine = createWorkflowEngine({ repository: runs, modules: createMerchGridModuleExecutor({ agentRunner: new OpenAiAgentRunner() }) });
  return {
    engine,
    service: createMerchGridWorkflowService({
      engine,
      runRepository: runs,
      artifacts: new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(dataDir, 'artifacts') }),
    }),
  };
}

function option(options: readonly string[], name: '--date' | '--through' | '--run-id'): string {
  const value = optionalOption(options, name);
  if (!value) throw new AppError('validation_failed', `Expected ${name} value`);
  return value;
}

function optionalOption(options: readonly string[], name: '--date' | '--through' | '--run-id'): string | undefined {
  const index = options.indexOf(name);
  return index < 0 ? undefined : options[index + 1];
}

function assertExactOptions(options: readonly string[], names: readonly ('--date' | '--through' | '--run-id')[]): void {
  if (options.length !== names.length * 2 || names.some((name) => options.filter((option) => option === name).length !== 1)) {
    throw new AppError('validation_failed', `Expected options: ${names.join(', ')}`);
  }
}

function assertOptions(
  options: readonly string[],
  required: readonly ('--date' | '--through' | '--run-id')[],
  optional: readonly ('--date' | '--through' | '--run-id')[],
): void {
  const names = [...required, ...optional];
  if (options.length % 2 !== 0 || options.some((value, index) => index % 2 === 0 && !names.includes(value as typeof names[number]))
    || names.some((name) => options.filter((value) => value === name).length > 1)
    || required.some((name) => !options.includes(name))) {
    throw new AppError('validation_failed', `Expected options: ${names.join(', ')}`);
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  if (!env[name]) throw new AppError('configuration_failed', `Missing required MerchGrid workflow configuration: ${name}`);
  return env[name]!;
}

function defaultMerchGridRunId(kind: 'daily' | 'weekly', subjectDate: string, now: Date): string {
  return `${formatRunDate(now)}-merchgrid-${kind}-${subjectDate}`;
}

function formatRunDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function printRun(writeLine: (line: string) => void, state: { runId: string; status: string; stage: string; evidenceRefs: string[] }): void {
  writeLine(`run: ${state.runId}`);
  writeLine(`status: ${state.status}`);
  writeLine(`stage: ${state.stage}`);
  writeLine(`artifact: ${state.evidenceRefs.at(-1) ?? 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMerchGridWorkflowCli({ args: process.argv.slice(2), dependencies: createMerchGridWorkflowDependencies(), writeLine: console.log })
    .catch((error) => { process.stderr.write(`${error instanceof AppError ? error.code : 'unexpected_error'}\n`); process.exitCode = 1; });
}

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAiAgentRunner } from '../agents/runner.js';
import { createMarketplaceVisibilityModuleExecutor } from '../agents/marketplace-visibility/modules.js';
import { createHostedWebSearchResearchTool } from '../agents/research/hosted-web-search.js';
import { loadMarketplaceResearchConfig } from '../agents/research/marketplace-config.js';
import { MarketplaceVisibilityProfileSchema, type MarketplaceVisibilityProfile } from '../contracts/marketplace-visibility.js';
import {
  loadMarketplaceListingContext,
  loadMarketplaceVisibilityContext,
} from '../connectors/marketplace/local-context.js';
import { AppError } from '../core/errors.js';
import { loadLocalEnvironment } from '../core/local-env.js';
import { JsonFileMerchGridReviewArtifactRepository } from '../jobs/merchgrid-source-pack.js';
import { JsonFileRunRepository, type RunRepository } from '../storage/runs.js';
import { createWorkflowEngine } from '../workflow/engine.js';
import { createMarketplaceVisibilityService } from '../workflow/marketplace-visibility-profile.js';

type RunState = { runId: string; status: string; stage: string; evidenceRefs: string[] };

export type MarketplaceVisibilityCliDependencies = {
  service: {
    startVisibilityReview?: (input: {
      profile: MarketplaceVisibilityProfile;
      runId: string;
      date?: string;
      contextPath: string;
      listingContextPath?: string;
    }) => Promise<RunState>;
    supplyVisibilityResult?: (input: { profile: MarketplaceVisibilityProfile; runId: string; through?: string }) => Promise<RunState>;
  };
  engine: {
    step?: (runId: string) => Promise<RunState>;
    approveExperiment?: (runId: string) => Promise<RunState>;
    rejectExperiment?: (input: { runId: string; reason: string }) => Promise<RunState>;
  };
  defaultContextPath?: string;
  defaultListingContextPath?: string;
  now?: () => Date;
};

export async function runMarketplaceVisibilityCli(input: {
  args: readonly string[];
  dependencies: MarketplaceVisibilityCliDependencies;
  writeLine: (line: string) => void;
}): Promise<void> {
  const [command, ...options] = input.args;

  if (command === 'visibility-review') {
    assertOptions(options, ['--profile'], ['--run-id', '--date', '--context', '--listing-context']);
    const profile = parseProfile(option(options, '--profile'));
    const date = optionalOption(options, '--date');
    if (profile === 'merchgrid_shopify_app_store' && !date) {
      throw new AppError('validation_failed', 'Expected --date value for merchgrid_shopify_app_store');
    }
    if (profile === 'etsy_listing' && date) {
      throw new AppError('validation_failed', '--date is not accepted for etsy_listing');
    }

    const contextPath = optionalOption(options, '--context') ?? input.dependencies.defaultContextPath;
    if (!contextPath) throw new AppError('configuration_failed', 'Missing required marketplace visibility context path');
    const listingContextPath = optionalOption(options, '--listing-context') ?? input.dependencies.defaultListingContextPath;

    const runId = optionalOption(options, '--run-id') ?? defaultVisibilityRunId({
      profile,
      date,
      hasListingContext: Boolean(listingContextPath),
      now: input.dependencies.now?.() ?? new Date(),
    });
    let state = await requireService(input.dependencies.service, 'startVisibilityReview')({
      profile,
      runId,
      date,
      contextPath,
      listingContextPath,
    });
    state = await continueWorkflowStages(
      state,
      runId,
      input.dependencies.engine,
      ['m1_context', 'm2_metrics_initial', 'm4_diagnosis', 'm5_hypothesis', 'm6_test_plan'],
    );
    return printRun(input.writeLine, state);
  }

  if (command === 'approve') {
    assertOptions(options, ['--run-id']);
    return printRun(input.writeLine, await requireEngine(input.dependencies.engine, 'approveExperiment')(option(options, '--run-id')));
  }

  if (command === 'reject') {
    assertOptions(options, ['--run-id', '--reason']);
    return printRun(
      input.writeLine,
      await requireEngine(input.dependencies.engine, 'rejectExperiment')({
        runId: option(options, '--run-id'),
        reason: option(options, '--reason'),
      }),
    );
  }

  if (command === 'record-result') {
    assertOptions(options, ['--profile', '--run-id'], ['--through']);
    const runId = option(options, '--run-id');
    let state = await requireService(input.dependencies.service, 'supplyVisibilityResult')({
      profile: parseProfile(option(options, '--profile')),
      runId,
      through: optionalOption(options, '--through'),
    });
    state = await continueWorkflowStages(state, runId, input.dependencies.engine, ['m2_metrics_results', 'm7_learning']);
    return printRun(input.writeLine, state);
  }

  throw new AppError('validation_failed', 'Expected visibility-review, approve, reject, or record-result command');
}

export function createMarketplaceVisibilityDependencies(
  env: NodeJS.ProcessEnv = loadLocalEnvironment(),
): MarketplaceVisibilityCliDependencies {
  const dataDir = required(env, 'MERCHGRID_METRICS_DATA_DIR');
  const runs: RunRepository = new JsonFileRunRepository({ rootDir: join(dataDir, 'workflow-runs') });
  const researchConfig = loadMarketplaceResearchConfig(env);
  const agentRunner = new OpenAiAgentRunner({ apiKey: env.OPENAI_API_KEY });
  const researchTool = researchConfig.enabled
    ? createHostedWebSearchResearchTool({ runner: agentRunner, config: researchConfig })
    : undefined;
  const engine = createWorkflowEngine({
    repository: runs,
    modules: createMarketplaceVisibilityModuleExecutor({
      agentRunner,
      research: { config: researchConfig, tool: researchTool },
    }),
    researchLimits: {
      maxToolCalls: researchConfig.limits.maxToolCalls,
      maxWallClockMs: researchConfig.limits.maxWallClockMs,
      permittedTools: ['hosted_web_search'],
      costBudget: {
        maxTokens: researchConfig.limits.maxTokens,
        maxEstimatedCostUsd: researchConfig.limits.maxEstimatedCostUsd,
      },
    },
  });

  return {
    engine,
    service: createMarketplaceVisibilityService({
      engine,
      merchgridArtifacts: new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(dataDir, 'artifacts') }),
      merchgridArtifactRootRef: join(dataDir, 'artifacts'),
      runRepository: runs,
      loadContext: loadMarketplaceVisibilityContext,
      loadListingContext: loadMarketplaceListingContext,
    }),
    defaultContextPath: env.MERCHGRID_VISIBILITY_CONTEXT_PATH,
    defaultListingContextPath: env.MERCHGRID_LISTING_CONTEXT_PATH,
  };
}

async function continueWorkflowStages(
  initialState: RunState,
  runId: string,
  engine: MarketplaceVisibilityCliDependencies['engine'],
  stages: readonly string[],
): Promise<RunState> {
  let state = initialState;
  while (
    (stages.includes(state.stage) && ['analyzing', 'ready_for_evaluation'].includes(state.status)) ||
    (state.stage === 'm3_research' && state.status === 'researching')
  ) {
    state = await requireEngine(engine, 'step')(runId);
  }
  return state;
}

function parseProfile(value: string): MarketplaceVisibilityProfile {
  const result = MarketplaceVisibilityProfileSchema.safeParse(value);
  if (!result.success) throw new AppError('validation_failed', 'Expected supported marketplace visibility profile');
  return result.data;
}

function option(options: readonly string[], name: string): string {
  const value = optionalOption(options, name);
  if (!value) throw new AppError('validation_failed', `Expected ${name} value`);
  return value;
}

function optionalOption(options: readonly string[], name: string): string | undefined {
  const index = options.indexOf(name);
  return index < 0 ? undefined : options[index + 1];
}

function assertOptions(options: readonly string[], required: readonly string[], optional: readonly string[] = []): void {
  const names = [...required, ...optional];
  if (options.length % 2 !== 0 || options.some((value, index) => index % 2 === 0 && !names.includes(value))
    || names.some((name) => options.filter((value) => value === name).length > 1)
    || required.some((name) => !options.includes(name))) {
    throw new AppError('validation_failed', `Expected options: ${names.join(', ')}`);
  }
}

function requireService<K extends keyof MarketplaceVisibilityCliDependencies['service']>(
  service: MarketplaceVisibilityCliDependencies['service'],
  name: K,
): NonNullable<MarketplaceVisibilityCliDependencies['service'][K]> {
  const method = service[name];
  if (!method) throw new AppError('configuration_failed', `Missing marketplace visibility service method: ${name}`);
  return method as NonNullable<MarketplaceVisibilityCliDependencies['service'][K]>;
}

function requireEngine<K extends keyof MarketplaceVisibilityCliDependencies['engine']>(
  engine: MarketplaceVisibilityCliDependencies['engine'],
  name: K,
): NonNullable<MarketplaceVisibilityCliDependencies['engine'][K]> {
  const method = engine[name];
  if (!method) throw new AppError('configuration_failed', `Missing marketplace visibility engine method: ${name}`);
  return method as NonNullable<MarketplaceVisibilityCliDependencies['engine'][K]>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  if (!env[name]) throw new AppError('configuration_failed', `Missing required marketplace visibility configuration: ${name}`);
  return env[name]!;
}

function defaultVisibilityRunId(input: {
  profile: MarketplaceVisibilityProfile;
  date: string | undefined;
  hasListingContext: boolean;
  now: Date;
}): string {
  const createdDate = formatRunDate(input.now);
  if (input.profile === 'merchgrid_shopify_app_store') {
    const suffix = input.hasListingContext ? '-listing-context' : '';
    return `${createdDate}-merchgrid-visibility-${input.date}${suffix}`;
  }
  return `${createdDate}-etsy-visibility-review`;
}

function formatRunDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function printRun(writeLine: (line: string) => void, state: RunState): void {
  writeLine(`run: ${state.runId}`);
  writeLine(`status: ${state.status}`);
  writeLine(`stage: ${state.stage}`);
  writeLine(`artifact: ${state.evidenceRefs.at(-1) ?? 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMarketplaceVisibilityCli({
    args: process.argv.slice(2),
    dependencies: createMarketplaceVisibilityDependencies(),
    writeLine: console.log,
  }).catch((error) => {
    process.stderr.write(`${error instanceof AppError ? error.code : 'unexpected_error'}\n`);
    process.exitCode = 1;
  });
}

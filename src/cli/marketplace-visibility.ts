import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAiAgentRunner } from '../agents/runner.js';
import { createMarketplaceVisibilityModuleExecutor } from '../agents/marketplace-visibility/modules.js';
import { createHostedWebSearchResearchTool } from '../agents/research/hosted-web-search.js';
import { loadMarketplaceResearchConfig } from '../agents/research/marketplace-config.js';
import {
  MarketplaceVisibilityProfileSchema,
  type MarketplaceVisibilityProfile,
} from '../contracts/marketplace-visibility.js';
import { UtcDateSchema } from '../contracts/metrics.js';
import {
  loadMarketplaceListingContext,
  loadRollingMarketplaceVisibilityContext,
  loadMarketplaceVisibilityContext,
} from '../connectors/marketplace/local-context.js';
import { AppError } from '../core/errors.js';
import { loadLocalEnvironment } from '../core/local-env.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  resolveLatestCompleteWeeklyThrough,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../jobs/merchgrid-source-pack.js';
import { toMerchGridReviewEvidence } from '../metrics/evidence.js';
import { JsonFileMetricSnapshotRepository } from '../storage/metric-snapshots.js';
import { JsonFileRunRepository } from '../storage/runs.js';
import { createWorkflowEngine } from '../workflow/engine.js';
import {
  createMarketplaceRollingReviewService,
  type MarketplaceRollingReviewService,
  type OwnerApplicationPrompt,
} from '../workflow/marketplace-rolling-review.js';
import { buildRollingVisibilityEvidence } from '../workflow/marketplace-visibility-profile.js';

export type MarketplaceVisibilityCliDependencies = {
  rollingReviews: MarketplaceRollingReviewService;
  resolveThrough: () => Promise<string>;
  resolveProductRef: (contextPath: string) => Promise<string>;
  defaultContextPath?: string;
  defaultListingContextPath?: string;
};

export type MarketplaceVisibilityEntrypointInput = {
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  dependencies?: MarketplaceVisibilityCliDependencies;
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
};

type OwnerPromptInterface = {
  question(prompt: string): Promise<string>;
  close(): void;
};

export type OwnerApplicationPromptOptions = {
  createInterface?: OwnerPromptInterface | (() => OwnerPromptInterface);
};

export async function runMarketplaceVisibilityCli(input: {
  args: readonly string[];
  dependencies: MarketplaceVisibilityCliDependencies;
  writeLine: (line: string) => void;
}): Promise<void> {
  const [command, ...options] = input.args;
  if (command !== 'next-review') {
    throw new AppError('validation_failed', 'Expected next-review command');
  }

  assertOptions(options, ['--profile']);
  const profile = parseProfile(option(options, '--profile'));
  const contextPath = input.dependencies.defaultContextPath;
  if (!contextPath) throw new AppError('configuration_failed', 'Missing required marketplace visibility context path');
  const productRef = await input.dependencies.resolveProductRef(contextPath);
  const through = await input.dependencies.resolveThrough();

  const result = await input.dependencies.rollingReviews.nextReview({
    profile,
    productRef,
    through,
    contextPath,
    ...(input.dependencies.defaultListingContextPath
      ? { listingContextPath: input.dependencies.defaultListingContextPath }
      : {}),
  });
  printReview(input.writeLine, result);
}

/** Keeps runtime failures on a bounded CLI channel while preserving actionable local evidence gaps. */
export async function runMarketplaceVisibilityEntrypoint(
  input: MarketplaceVisibilityEntrypointInput,
): Promise<void> {
  try {
    await runMarketplaceVisibilityCli({
      args: input.args,
      dependencies: input.dependencies ?? createMarketplaceVisibilityDependencies(input.env),
      writeLine: input.writeLine,
    });
  } catch (error) {
    input.writeError(safeCliError(error));
  }
}

/** Creates the interactive approval boundary used only by the runtime composition. */
export function createOwnerApplicationPrompt(options: OwnerApplicationPromptOptions = {}): OwnerApplicationPrompt {
  const suppliedInterface = options.createInterface;
  const interfaceFactory: () => OwnerPromptInterface = typeof suppliedInterface === 'function'
    ? suppliedInterface
    : () => suppliedInterface ?? createInterface({ input: process.stdin, output: process.stdout });

  return {
    async confirm(input) {
      let terminal: OwnerPromptInterface | undefined;
      try {
        terminal = interfaceFactory();
        const applied = await askYesNo(
          terminal,
          `Experiment for ${input.previousRunId}: ${input.experimentSummary}\nWas it applied? (yes/no) `,
        );
        if (!applied) return { status: 'not_applied' };
        return { status: 'applied', appliedAt: await askUtcDate(terminal) };
      } catch {
        return { status: 'cancelled' };
      } finally {
        terminal?.close();
      }
    },
  };
}

/** Builds the runtime graph from local persisted evidence; source-provider adapters are intentionally absent. */
export function createMarketplaceVisibilityDependencies(
  env: NodeJS.ProcessEnv = loadLocalEnvironment(),
): MarketplaceVisibilityCliDependencies {
  const dataDir = required(env, 'MERCHGRID_METRICS_DATA_DIR');
  const layout = marketplaceVisibilityStorageLayout(dataDir);
  const artifacts = new JsonFileMerchGridReviewArtifactRepository({ rootDir: layout.artifactRoot });
  const snapshotRepository = new JsonFileMetricSnapshotRepository({ rootDir: join(dataDir, 'snapshots') });
  const weeklyEvidenceDependencies: MerchGridSourcePackDependencies = {
    adapters: [],
    repository: snapshotRepository,
    artifacts,
  };
  const runs = new JsonFileRunRepository({ rootDir: layout.runRoot });
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
    rollingReviews: createMarketplaceRollingReviewService({
      history: runs,
      engine,
      prompt: createOwnerApplicationPrompt(),
      now: () => new Date(),
      runRootRef: layout.runRoot,
      prepareWeeklyEvidence: async (input) => {
        const artifact = await artifacts.loadWeeklyReview(input.through)
          ?? toMerchGridReviewEvidence((await runWeeklyReview({ through: input.through, dependencies: weeklyEvidenceDependencies })).review);
        const context = await loadMarketplaceVisibilityContext(input.contextPath);
        const listingContext = input.listingContextPath
          ? await loadMarketplaceListingContext(input.listingContextPath)
          : undefined;
        return buildRollingVisibilityEvidence({
          artifact,
          identity: input.identity,
          through: input.through,
          context,
          listingContext,
          artifactRootRef: layout.artifactRoot,
        });
      },
    }),
    resolveThrough: () => resolveLatestCompleteWeeklyThrough({ repository: snapshotRepository }),
    resolveProductRef: async (contextPath) => (await loadRollingMarketplaceVisibilityContext(contextPath)).productRef,
    defaultContextPath: env.MERCHGRID_VISIBILITY_CONTEXT_PATH,
    defaultListingContextPath: env.MERCHGRID_LISTING_CONTEXT_PATH,
  };
}

/** Keeps physical storage and persisted local references on the same documented layout. */
export function marketplaceVisibilityStorageLayout(dataDir: string): {
  artifactRoot: string;
  runRoot: string;
} {
  return {
    artifactRoot: join(dataDir, 'artifacts'),
    runRoot: join(dataDir, 'workflow-runs'),
  };
}

async function askYesNo(terminal: OwnerPromptInterface, prompt: string): Promise<boolean> {
  let question = prompt;
  while (true) {
    const response = (await terminal.question(question)).trim().toLowerCase();
    if (response === 'yes') return true;
    if (response === 'no') return false;
    question = 'Please answer yes or no. Was it applied? (yes/no) ';
  }
}

async function askUtcDate(terminal: OwnerPromptInterface): Promise<string> {
  let question = 'Applied UTC date (YYYY-MM-DD): ';
  while (true) {
    const result = UtcDateSchema.safeParse((await terminal.question(question)).trim());
    if (result.success) return result.data;
    question = 'Enter a valid UTC date (YYYY-MM-DD): ';
  }
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
  if (
    options.length % 2 !== 0
    || options.some((value, index) => index % 2 === 0 && !names.includes(value))
    || options.some((_, index) => index % 2 === 0 && (!options[index + 1] || options[index + 1]!.startsWith('--')))
    || names.some((name) => options.filter((value) => value === name).length > 1)
    || required.some((name) => !options.includes(name))
  ) {
    throw new AppError('validation_failed', `Expected options: ${names.join(', ')}`);
  }
}

function printReview(
  writeLine: (line: string) => void,
  result: Awaited<ReturnType<MarketplaceRollingReviewService['nextReview']>>,
): void {
  if (result.previousRun) writeLine(`previous: ${result.previousRun.runId} (${result.previousRun.resolution})`);
  writeLine(`run: ${result.currentRun.runId}`);
  writeLine(`status: ${result.currentRun.status}`);
  writeLine(`stage: ${result.currentRun.stage}`);
  if (result.currentRun.experimentPlanRef) writeLine(`experiment-plan: ${result.currentRun.experimentPlanRef}`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  if (!env[name]) throw new AppError('configuration_failed', `Missing required marketplace visibility configuration: ${name}`);
  return env[name]!;
}

const MISSING_WEEKLY_SNAPSHOTS = /^Missing weekly metric snapshots \((?:[1-9]|[1-3]\d|4[0-2])\): (?:posthog|fly_metrics|shopify_partner)\/\d{4}-\d{2}-\d{2}(?:, (?:posthog|fly_metrics|shopify_partner)\/\d{4}-\d{2}-\d{2}){0,41}$/u;

function safeCliError(error: unknown): string {
  if (!(error instanceof AppError)) return 'unexpected_error';
  if (error.code === 'storage_failed' && MISSING_WEEKLY_SNAPSHOTS.test(error.message)) {
    return `${error.code}: ${error.message}`;
  }
  return error.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMarketplaceVisibilityEntrypoint({
    args: process.argv.slice(2),
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => {
      process.stderr.write(`${line}\n`);
      process.exitCode = 1;
    },
  });
}

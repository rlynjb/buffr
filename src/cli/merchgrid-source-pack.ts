import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MetricSource } from '../contracts/metrics.js';
import { FlyMetricsSourceAdapter } from '../connectors/merchgrid/fly-metrics.js';
import { PosthogMetricSourceAdapter } from '../connectors/merchgrid/posthog.js';
import { ShopifyPartnerCsvMetricSource } from '../connectors/merchgrid/shopify-partner-csv.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../connectors/merchgrid/source.js';
import { AppError } from '../core/errors.js';
import {
  JsonFileMerchGridReviewArtifactRepository,
  runDailyCollection,
  runWeeklyReview,
  type MerchGridSourcePackDependencies,
} from '../jobs/merchgrid-source-pack.js';
import { JsonFileMetricSnapshotRepository } from '../storage/metric-snapshots.js';

const SOURCES: readonly MetricSource[] = ['posthog', 'fly_metrics', 'shopify_partner'];

export type MerchGridSourcePackCliInput = {
  args: readonly string[];
  dependencies: MerchGridSourcePackDependencies;
  writeLine: (line: string) => void;
};

export type MerchGridSourcePackRuntimeDependenciesOptions = {
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
};

export type MerchGridSourcePackEntrypointInput = {
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
};

/** Runs one explicit collection or review command and emits only its artifact path and source states. */
export async function runMerchGridSourcePackCli(input: MerchGridSourcePackCliInput): Promise<void> {
  const [command, ...options] = input.args;

  if (command === 'collect') {
    const result = await runDailyCollection({ date: optionValue(options, '--date'), dependencies: input.dependencies });
    printResult(input.writeLine, result.artifactPath, result.sourceStatuses);
    return;
  }

  if (command === 'weekly-review') {
    const result = await runWeeklyReview({ through: optionValue(options, '--through'), dependencies: input.dependencies });
    printResult(input.writeLine, result.artifactPath, result.sourceStatuses);
    return;
  }

  throw new AppError('validation_failed', 'Expected collect or weekly-review command');
}

/** Builds the runtime-only dependency graph; tests supply their own fakes instead. */
export function createMerchGridSourcePackDependencies(
  options: MerchGridSourcePackRuntimeDependenciesOptions = {},
): MerchGridSourcePackDependencies {
  const env = options.env ?? process.env;
  const dataDir = requiredSetting(env, 'MERCHGRID_METRICS_DATA_DIR');
  const http = options.http ?? new FetchHttpClient();
  return {
    adapters: [
      new PosthogMetricSourceAdapter({
        http,
        config: {
          projectId: requiredSetting(env, 'POSTHOG_PROJECT_ID'),
          personalApiKey: requiredSetting(env, 'POSTHOG_PERSONAL_API_KEY'),
          apiBaseUrl: requiredSetting(env, 'POSTHOG_BASE_URL'),
        },
      }),
      new FlyMetricsSourceAdapter({
        http,
        config: {
          accessToken: requiredSetting(env, 'FLY_ACCESS_TOKEN'),
          appName: requiredSetting(env, 'FLY_APP_NAME'),
          metricsUrl: flyMetricsUrl(requiredSetting(env, 'FLY_ORG_SLUG')),
        },
      }),
      new ShopifyPartnerCsvMetricSource({
        config: { csvPath: requiredSetting(env, 'SHOPIFY_PARTNER_AGGREGATES_CSV_PATH') },
      }),
    ],
    repository: new JsonFileMetricSnapshotRepository({ rootDir: join(dataDir, 'snapshots') }),
    artifacts: new JsonFileMerchGridReviewArtifactRepository({ rootDir: join(dataDir, 'artifacts') }),
  };
}

/** Catches runtime setup and command failures so CLI errors remain bounded. */
export async function runMerchGridSourcePackEntrypoint(input: MerchGridSourcePackEntrypointInput): Promise<void> {
  try {
    await runMerchGridSourcePackCli({
      args: input.args,
      dependencies: createMerchGridSourcePackDependencies({ env: input.env }),
      writeLine: input.writeLine,
    });
  } catch (error) {
    input.writeError(error instanceof AppError ? error.code : 'unexpected_error');
  }
}

class FetchHttpClient implements HttpClient {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
}

function optionValue(options: readonly string[], name: '--date' | '--through'): string {
  if (options.length !== 2 || options[0] !== name || !options[1]) {
    throw new AppError('validation_failed', `Expected ${name} YYYY-MM-DD`);
  }
  return options[1];
}

function printResult(
  writeLine: (line: string) => void,
  artifactPath: string,
  sourceStatuses: Record<MetricSource, string>,
): void {
  writeLine(`artifact: ${artifactPath}`);
  writeLine(`sources: ${SOURCES.map((source) => `${source}=${sourceStatuses[source]}`).join(' ')}`);
}

function requiredSetting(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new AppError('configuration_failed', `Missing required MerchGrid metrics configuration: ${name}`);
  }
  return value;
}

function flyMetricsUrl(organization: string): string {
  return `https://api.fly.io/prometheus/${encodeURIComponent(organization)}/api/v1/query`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMerchGridSourcePackEntrypoint({
    args: process.argv.slice(2),
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => {
      process.stderr.write(`${line}\n`);
      process.exitCode = 1;
    },
  });
}

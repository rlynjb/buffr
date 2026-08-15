import { pathToFileURL } from 'node:url';
import { loadEtsyConnectorConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type { EtsyTokenProvider } from './auth.js';
import { unavailableEtsyTokenProvider } from './auth.js';
import { EtsyOpenApiClient } from './client.js';
import { createEtsyEvidenceRepository } from './repository.js';

export async function validateEtsyConnection(input: {
  env: NodeJS.ProcessEnv;
  listingId: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: EtsyTokenProvider;
}): Promise<{ ok: true; listingId: string; title: string }> {
  const config = loadEtsyConnectorConfig(input.env);
  const client = new EtsyOpenApiClient({
    config,
    tokenProvider: input.tokenProvider ?? unavailableEtsyTokenProvider(),
    fetchImpl: input.fetchImpl,
  });
  const repository = createEtsyEvidenceRepository({ client });
  const evidence = await repository.getListingEvidence(input.listingId);

  return { ok: true, listingId: evidence.listingId, title: evidence.title };
}

async function main(): Promise<void> {
  try {
    const listingId = process.env.ETSY_VALIDATE_LISTING_ID;
    if (!listingId) {
      throw new AppError('configuration_failed', 'Missing required Etsy connector configuration: ETSY_VALIDATE_LISTING_ID');
    }

    const result = await validateEtsyConnection({ env: process.env, listingId });
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof AppError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    console.error('connector_failed: Etsy validation failed');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

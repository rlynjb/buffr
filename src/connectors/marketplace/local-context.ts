import { readFile } from 'node:fs/promises';
import { MarketplaceVisibilityContextSchema } from '../../contracts/marketplace-visibility.js';
import { AppError } from '../../core/errors.js';

/** Loads a strictly validated marketplace context from a local JSON file. */
export async function loadMarketplaceVisibilityContext(path: string) {
  if (!path || path.includes('://')) {
    throw new AppError('validation_failed', 'Marketplace visibility context path must be a local file');
  }
  try {
    return MarketplaceVisibilityContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'Marketplace visibility context could not be loaded', { cause: error });
  }
}

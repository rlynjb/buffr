import { readFile } from 'node:fs/promises';
import {
  MarketplaceListingContextSchema,
  MarketplaceVisibilityContextSchema,
  RollingMarketplaceVisibilityContextSchema,
} from '../../contracts/marketplace-visibility.js';
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

/** Loads a rolling context that includes the stable product identity required for cycle lookup. */
export async function loadRollingMarketplaceVisibilityContext(path: string) {
  if (!path || path.includes('://')) {
    throw new AppError('validation_failed', 'Rolling marketplace visibility context path must be a local file');
  }
  try {
    return RollingMarketplaceVisibilityContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'Rolling marketplace visibility context could not be loaded', { cause: error });
  }
}

/** Loads a strictly validated marketplace listing context from a local JSON file. */
export async function loadMarketplaceListingContext(path: string) {
  if (!path || path.includes('://')) {
    throw new AppError('validation_failed', 'Marketplace listing context path must be a local file');
  }
  try {
    return MarketplaceListingContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation_failed', 'Marketplace listing context could not be loaded', { cause: error });
  }
}

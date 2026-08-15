import type { NormalizedListingEvidence } from '../../contracts/evidence.js';
import type { EtsyHttpClient } from './client.js';
import { mapEtsyListingToEvidence } from './mapper.js';

export type EtsyEvidenceRepository = {
  getListingEvidence(listingId: string): Promise<NormalizedListingEvidence>;
  getListingTransactions(listingId: string): Promise<unknown[]>;
};

export function createEtsyEvidenceRepository(input: {
  client: EtsyHttpClient;
  now?: () => string;
}): EtsyEvidenceRepository {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async getListingEvidence(listingId: string): Promise<NormalizedListingEvidence> {
      const listing = await input.client.getJson<unknown>(`/listings/${encodeURIComponent(listingId)}`);
      return mapEtsyListingToEvidence(listing, now());
    },

    async getListingTransactions(listingId: string): Promise<unknown[]> {
      const response = await input.client.getJson<unknown>(`/listings/${encodeURIComponent(listingId)}/transactions`);
      if (Array.isArray(response)) {
        return response;
      }

      if (response && typeof response === 'object' && Array.isArray((response as { results?: unknown }).results)) {
        return (response as { results: unknown[] }).results;
      }

      return [];
    },
  };
}

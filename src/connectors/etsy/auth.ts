import { AppError } from '../../core/errors.js';

export type EtsyTokenProvider = {
  getAccessToken(): Promise<string>;
};

export function unavailableEtsyTokenProvider(): EtsyTokenProvider {
  return {
    async getAccessToken(): Promise<string> {
      throw new AppError('configuration_failed', 'Etsy OAuth token provider is not configured');
    },
  };
}

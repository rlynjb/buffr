import type { Evidence } from '@buffr/contracts';

export interface DataConnector<TParams, TData> {
  readonly id: string;
  fetch(params: TParams, options?: FetchOptions): Promise<ConnectorResult<TData>>;
}

export type ConnectorResult<TData> = {
  data: TData;
  fetchedAt: string;
  sourceId: string;
  toEvidence(): Evidence[];
};

export type FetchOptions = { signal?: AbortSignal };

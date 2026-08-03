import type { Evidence } from '@buffr/contracts';
import type { DataConnector, ConnectorResult, FetchOptions } from '../contracts.js';

export type TrendsParams = {
  keywords: string[];
  geo?: string;
  timeframe?: string;
};

export type TrendPoint = { date: string; value: number };

export type TrendResult = {
  keyword: string;
  geo: string;
  timeframe: string;
  timeline: TrendPoint[];
  averageInterest: number;
};

export type TrendsRequestOpts = {
  keywords: string[];
  geo: string;
  timeframe: string;
};

export type TrendsTransport = (opts: TrendsRequestOpts) => Promise<TrendResult[]>;

// google-trends-api is a CJS package with no TypeScript types.
// Only used in defaultTrendsCall — the injectable transport keeps tests offline.
type GoogleTrendsModule = {
  default: {
    interestOverTime(opts: {
      keyword: string | string[];
      geo?: string;
      startTime?: Date;
      endTime?: Date;
    }): Promise<string>;
  };
};

type RawTimelineData = {
  default: {
    timelineData: Array<{
      time: string;
      value: number[];
    }>;
  };
};

function resolveTimeWindow(timeframe: string): { startTime: Date; endTime: Date } {
  const endTime = new Date();
  const startTime = new Date(endTime);
  if (timeframe === 'today 12-m') {
    startTime.setMonth(startTime.getMonth() - 12);
  } else {
    // default: 'now 7-d'
    startTime.setDate(startTime.getDate() - 7);
  }
  return { startTime, endTime };
}

async function defaultTrendsCall(opts: TrendsRequestOpts): Promise<TrendResult[]> {
  const { startTime, endTime } = resolveTimeWindow(opts.timeframe);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — google-trends-api is a CJS package with no type declarations
  const mod = await import('google-trends-api') as unknown as GoogleTrendsModule;
  const raw = await mod.default.interestOverTime({
    keyword: opts.keywords,
    geo: opts.geo,
    startTime,
    endTime,
  });
  if (typeof raw === 'string' && raw.trimStart().startsWith('<')) {
    throw new Error('Google Trends returned an HTML page — likely rate-limited or blocked');
  }
  const parsed = JSON.parse(raw) as RawTimelineData;
  const timeline = parsed.default.timelineData;

  return opts.keywords.map((keyword, idx) => {
    const points: TrendPoint[] = timeline.map((t) => ({
      date: new Date(Number(t.time) * 1000).toISOString(),
      value: t.value[idx] ?? 0,
    }));
    const averageInterest = points.length > 0
      ? Math.round(points.reduce((sum, p) => sum + p.value, 0) / points.length)
      : 0;
    return { keyword, geo: opts.geo, timeframe: opts.timeframe, timeline: points, averageInterest };
  });
}

export class GoogleTrendsConnector implements DataConnector<TrendsParams, TrendResult[]> {
  readonly id = 'discovery.search-trends.google';

  constructor(private readonly call: TrendsTransport = defaultTrendsCall) {}

  async fetch(params: TrendsParams, _opts?: FetchOptions): Promise<ConnectorResult<TrendResult[]>> {
    const geo = params.geo ?? '';
    const timeframe = params.timeframe ?? 'now 7-d';
    const data = await this.call({ keywords: params.keywords, geo, timeframe });
    const fetchedAt = new Date().toISOString();

    return {
      data,
      fetchedAt,
      sourceId: `trends:${params.keywords.join(',')}`,
      toEvidence(): Evidence[] {
        return data.map((trend) => ({
          sourceId: `trends:${trend.keyword}:${fetchedAt}`,
          sourceType: 'search-trends',
          title: `Search trend: "${trend.keyword}"`,
          excerpt: `Average interest: ${trend.averageInterest}/100 over ${trend.timeframe} (geo: ${trend.geo || 'worldwide'})`,
          retrievedAt: fetchedAt,
          freshness: 'recent',
        }));
      },
    };
  }
}

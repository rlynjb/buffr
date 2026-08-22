import { readFile } from 'node:fs/promises';
import type { CollectionWindow, DailyMetricSnapshot } from '../../contracts/metrics.js';
import type { ShopifyPartnerCsvConfig } from '../../core/config.js';
import { MetricSourceAdapterBase } from './source.js';

const REQUIRED_COLUMNS = ['date', 'active_merchants', 'installs', 'uninstalls', 'earnings_amount'] as const;
type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

export type ShopifyPartnerCsvMetricSourceOptions = {
  config: ShopifyPartnerCsvConfig;
  now?: () => string;
};

export class ShopifyPartnerCsvMetricSource extends MetricSourceAdapterBase {
  readonly source = 'shopify_partner' as const;

  private readonly config: ShopifyPartnerCsvConfig;
  private readonly now: () => string;

  constructor(options: ShopifyPartnerCsvMetricSourceOptions) {
    super();
    this.config = options.config;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  protected async collectMetrics(window: CollectionWindow): Promise<DailyMetricSnapshot> {
    const csv = await readFile(this.config.csvPath, 'utf8');
    const rows = parseCsv(csv);
    const [header, ...dataRows] = rows;
    const columnIndexes = requiredColumnIndexes(header);
    const matchingRows = dataRows.filter((row) => row[columnIndexes.date] === window.date);

    if (matchingRows.length === 0) {
      return unavailableSnapshot(this.source, window, this.now());
    }
    if (matchingRows.length !== 1) {
      throw { malformed: true };
    }

    const row = matchingRows[0];
    return {
      source: this.source,
      date: window.date,
      collectedAt: this.now(),
      status: 'complete',
      metrics: {
        active_merchants: parseNonnegativeNumber(row[columnIndexes.active_merchants]),
        installs: parseNonnegativeNumber(row[columnIndexes.installs]),
        uninstalls: parseNonnegativeNumber(row[columnIndexes.uninstalls]),
        earnings_amount: parseNonnegativeNumber(row[columnIndexes.earnings_amount]),
      },
      notes: ['manual_import'],
    };
  }
}

function unavailableSnapshot(
  source: 'shopify_partner',
  window: CollectionWindow,
  collectedAt: string,
): DailyMetricSnapshot {
  return {
    source,
    date: window.date,
    collectedAt,
    status: 'unavailable',
    metrics: {},
    notes: ['no_metrics'],
  };
}

function requiredColumnIndexes(header: readonly string[] | undefined): Record<RequiredColumn, number> {
  if (!header) {
    throw { malformed: true };
  }

  const indexes = {} as Record<RequiredColumn, number>;
  for (const column of REQUIRED_COLUMNS) {
    const index = header.indexOf(column);
    if (index === -1 || header.indexOf(column, index + 1) !== -1) {
      throw { malformed: true };
    }
    indexes[column] = index;
  }
  return indexes;
}

function parseNonnegativeNumber(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    throw { malformed: true };
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw { malformed: true };
  }
  return number;
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"') {
      if (value !== '') {
        throw { malformed: true };
      }
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) {
    throw { malformed: true };
  }
  if (value !== '' || row.length > 0) {
    row.push(value.replace(/\r$/u, ''));
    rows.push(row);
  }

  if (rows[0]?.[0]?.charCodeAt(0) === 0xfeff) {
    rows[0][0] = rows[0][0].slice(1);
  }
  return rows.filter((candidate) => candidate.length !== 1 || candidate[0] !== '');
}

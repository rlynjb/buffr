import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShopifyPartnerCsvMetricSource } from '../../connectors/merchgrid/shopify-partner-csv.js';
import { completedMerchGridWindow } from '../fixtures/merchgrid-metrics.js';

describe('Shopify Partner aggregate CSV adapter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('reads the matching aggregate day and labels it manual import', async () => {
    const csvPath = await writeCsv(
      [
        'date,active_merchants,installs,uninstalls,earnings_amount,merchant_identity',
        '2026-08-20,3,1,0,8.50,merchant-one',
        '2026-08-21,4,2,1,19.99,merchant-two',
      ].join('\n'),
    );
    const importer = new ShopifyPartnerCsvMetricSource({
      config: { csvPath },
      now: () => '2026-08-22T00:05:00.000Z',
    });

    await expect(importer.collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'shopify_partner',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'complete',
      metrics: {
        active_merchants: 4,
        installs: 2,
        uninstalls: 1,
        earnings_amount: 19.99,
      },
      notes: ['manual_import'],
    });
  });

  it('does not parse or retain values from other dates or unapproved columns', async () => {
    const csvPath = await writeCsv(
      [
        'date,active_merchants,installs,uninstalls,earnings_amount,merchant_identity',
        '2026-08-20,not-a-number,not-a-number,not-a-number,not-a-number,merchant-one',
        '2026-08-21,4,2,1,19.99,merchant-two',
      ].join('\n'),
    );
    const importer = new ShopifyPartnerCsvMetricSource({
      config: { csvPath },
      now: () => '2026-08-22T00:05:00.000Z',
    });

    const snapshot = await importer.collect(completedMerchGridWindow);

    expect(snapshot.metrics).toEqual({
      active_merchants: 4,
      installs: 2,
      uninstalls: 1,
      earnings_amount: 19.99,
    });
    expect(JSON.stringify(snapshot)).not.toContain('merchant-two');
  });

  it('returns unavailable when the selected date is absent', async () => {
    const csvPath = await writeCsv(
      ['date,active_merchants,installs,uninstalls,earnings_amount', '2026-08-20,3,1,0,8.50'].join('\n'),
    );
    const importer = new ShopifyPartnerCsvMetricSource({
      config: { csvPath },
      now: () => '2026-08-22T00:05:00.000Z',
    });

    await expect(importer.collect(completedMerchGridWindow)).resolves.toEqual({
      source: 'shopify_partner',
      date: '2026-08-21',
      collectedAt: '2026-08-22T00:05:00.000Z',
      status: 'unavailable',
      metrics: {},
      notes: ['no_metrics'],
    });
  });

  it('normalizes a missing input file without exposing its path', async () => {
    const importer = new ShopifyPartnerCsvMetricSource({
      config: { csvPath: join(tmpdir(), 'missing-shopify-partner-aggregates.csv') },
    });

    const snapshot = await importer.collect(completedMerchGridWindow);

    expect(snapshot).toEqual({
      source: 'shopify_partner',
      date: '2026-08-21',
      collectedAt: expect.any(String),
      status: 'failed',
      metrics: {},
      notes: ['transport'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('missing-shopify-partner-aggregates.csv');
  });

  it('normalizes a missing required header without retaining CSV content', async () => {
    const csvPath = await writeCsv(['date,installs', '2026-08-21,2'].join('\n'));
    const importer = new ShopifyPartnerCsvMetricSource({ config: { csvPath } });

    const snapshot = await importer.collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({
      source: 'shopify_partner',
      date: '2026-08-21',
      status: 'failed',
      metrics: {},
      notes: ['schema'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('date,installs');
  });

  it('normalizes duplicate selected-date rows without retaining CSV content', async () => {
    const csvPath = await writeCsv(
      [
        'date,active_merchants,installs,uninstalls,earnings_amount',
        '2026-08-21,4,2,1,19.99',
        '2026-08-21,7,3,0,31.00',
      ].join('\n'),
    );
    const importer = new ShopifyPartnerCsvMetricSource({ config: { csvPath } });

    const snapshot = await importer.collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({ status: 'failed', metrics: {}, notes: ['schema'] });
    expect(JSON.stringify(snapshot)).not.toContain('31.00');
  });

  it.each(['-1', 'Infinity', ''])('normalizes an invalid selected-row value (%j)', async (earningsAmount) => {
    const csvPath = await writeCsv(
      [
        'date,active_merchants,installs,uninstalls,earnings_amount',
        `2026-08-21,4,2,1,${earningsAmount}`,
      ].join('\n'),
    );
    const importer = new ShopifyPartnerCsvMetricSource({ config: { csvPath } });

    const snapshot = await importer.collect(completedMerchGridWindow);

    expect(snapshot).toMatchObject({ status: 'failed', metrics: {}, notes: ['schema'] });
  });

  async function writeCsv(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'merchgrid-shopify-csv-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'partner-aggregates.csv');
    await writeFile(path, contents, 'utf8');
    return path;
  }
});

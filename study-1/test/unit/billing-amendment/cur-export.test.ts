// CUR 2.0 column projection (BR-RUA-047): lines keep every cell as exported and get the id `row:<n>`;
// a missing line column makes attribution incomplete; the billing period must be one readable
// period, final only when every record carries an invoice id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CurTable } from '../../../src/billing-amendment/cur-csv.ts';
import { parseCurCsv } from '../../../src/billing-amendment/cur-csv.ts';
import {
  CUR_LINE_COLUMNS,
  CUR_PERIOD_COLUMNS,
  readCurLines,
  readExportPeriod,
} from '../../../src/billing-amendment/cur-export.ts';
import { CUR_HEADER, PROVIDER_ARN, RUN_ID, csvBytes, curCsv, curRecord } from './support/cur-export-builder.ts';

function tableOf(text: string): CurTable {
  const parsed = parseCurCsv(csvBytes(text));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.value;
}

function periodProblem(text: string): string {
  const period = readExportPeriod(tableOf(text));
  assert.ok(!period.ok, JSON.stringify(period));
  assert.equal(period.error.code, 'CUR_EXPORT_PERIOD_UNREADABLE');
  assert.equal(period.error.subject, 'BR-RUA-047');
  return period.error.detail;
}

const PERIOD_EXPECTATION =
  'expected every record to name one billing period as bill_billing_period_start_date < bill_billing_period_end_date (YYYY-MM-DDTHH:mm:ssZ)';

describe('readCurLines', () => {
  it('projects each record onto the line fields, whatever the column order', () => {
    const reversed = [...CUR_HEADER].reverse();
    const lines = readCurLines(
      tableOf(curCsv([curRecord(), curRecord({ [CUR_LINE_COLUMNS.cost]: '0.25' })], reversed)),
    );
    assert.deepEqual(lines, {
      ok: true,
      value: [
        {
          line_id: 'row:1',
          usage_account_id: '123456789012',
          line_item_type: 'Usage',
          resource_id: PROVIDER_ARN,
          product_code: 'AWSLambda',
          operation: 'Invoke',
          usage_start: '2026-10-05T10:00:00Z',
          usage_end: '2026-10-05T11:00:00Z',
          currency: 'USD',
          cost: '0.5',
          run_tag: RUN_ID,
        },
        {
          line_id: 'row:2',
          usage_account_id: '123456789012',
          line_item_type: 'Usage',
          resource_id: PROVIDER_ARN,
          product_code: 'AWSLambda',
          operation: 'Invoke',
          usage_start: '2026-10-05T10:00:00Z',
          usage_end: '2026-10-05T11:00:00Z',
          currency: 'USD',
          cost: '0.25',
          run_tag: RUN_ID,
        },
      ],
    });
  });

  it('reports every missing line column as incomplete attribution', () => {
    const header = CUR_HEADER.filter(
      (column) => column !== CUR_LINE_COLUMNS.resource_id && column !== CUR_LINE_COLUMNS.run_tag,
    );
    const lines = readCurLines(tableOf(curCsv([curRecord()], header)));
    assert.deepEqual(lines, {
      ok: false,
      error: {
        code: 'INCOMPLETE_ATTRIBUTION',
        subject: 'BR-RUA-047',
        detail:
          'the export lacks column(s) line_item_resource_id, resource_tag_suc_run_id; expected every line column of ' +
          'line_item_usage_account_id, line_item_line_item_type, line_item_resource_id, line_item_product_code, ' +
          'line_item_operation, line_item_usage_start_date, line_item_usage_end_date, line_item_currency_code, ' +
          'line_item_unblended_cost, resource_tag_suc_run_id',
      },
    });
  });

  it('reads no lines from a header-only export', () => {
    assert.deepEqual(readCurLines(tableOf(curCsv([]))), { ok: true, value: [] });
  });

  it('ignores extra columns, including inherited member names (A-05)', () => {
    const header = ['__proto__', ...CUR_HEADER, 'constructor'];
    const record = curRecord({ ['__proto__']: 'x', constructor: 'y' });
    const lines = readCurLines(tableOf(curCsv([record], header)));
    assert.ok(lines.ok);
    const [first] = lines.value;
    assert.ok(first !== undefined);
    assert.equal(first.cost, '0.5');
    assert.equal(Object.hasOwn(first, 'constructor'), false);
  });
});

describe('readExportPeriod', () => {
  it('reads one final period when every record has an invoice id', () => {
    assert.deepEqual(readExportPeriod(tableOf(curCsv([curRecord(), curRecord()]))), {
      ok: true,
      value: { period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-11-01T00:00:00.000Z', period_final: true },
    });
  });

  it('is not final when any invoice id is blank or whitespace', () => {
    const blank = curRecord({ [CUR_PERIOD_COLUMNS.invoice]: ' ' });
    const period = readExportPeriod(tableOf(curCsv([curRecord(), blank])));
    assert.ok(period.ok);
    assert.equal(period.value.period_final, false);
  });

  it('is not final when the export has no invoice column', () => {
    const header = CUR_HEADER.filter((column) => column !== CUR_PERIOD_COLUMNS.invoice);
    const period = readExportPeriod(tableOf(curCsv([curRecord()], header)));
    assert.ok(period.ok);
    assert.equal(period.value.period_final, false);
  });

  it('refuses an export without a period column', () => {
    for (const missing of [CUR_PERIOD_COLUMNS.start, CUR_PERIOD_COLUMNS.end]) {
      const header = CUR_HEADER.filter((column) => column !== missing);
      assert.equal(
        periodProblem(curCsv([curRecord()], header)),
        `the export lacks bill_billing_period_start_date or bill_billing_period_end_date; ${PERIOD_EXPECTATION}`,
      );
    }
  });

  it('refuses an export without records', () => {
    assert.equal(periodProblem(curCsv([])), `the export names 0 period start(s) and 0 end(s); ${PERIOD_EXPECTATION}`);
  });

  it('refuses records that name different periods', () => {
    const otherStart = curRecord({ [CUR_PERIOD_COLUMNS.start]: '2026-09-01T00:00:00Z' });
    assert.equal(
      periodProblem(curCsv([curRecord(), otherStart])),
      `the export names 2 period start(s) and 1 end(s); ${PERIOD_EXPECTATION}`,
    );
    const otherEnd = curRecord({ [CUR_PERIOD_COLUMNS.end]: '2026-12-01T00:00:00Z' });
    assert.equal(
      periodProblem(curCsv([curRecord(), otherEnd])),
      `the export names 1 period start(s) and 2 end(s); ${PERIOD_EXPECTATION}`,
    );
  });

  it('refuses an unreadable or empty period', () => {
    const cases: readonly [string, string][] = [
      ['2026-10-01', '2026-11-01T00:00:00Z'],
      ['2026-10-01T00:00:00Z', 'soon'],
      ['2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'],
      ['2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z'],
    ];
    for (const [start, end] of cases) {
      const record = curRecord({ [CUR_PERIOD_COLUMNS.start]: start, [CUR_PERIOD_COLUMNS.end]: end });
      assert.equal(
        periodProblem(curCsv([record])),
        `the period ${JSON.stringify(start)} to ${JSON.stringify(end)} is unreadable; ${PERIOD_EXPECTATION}`,
      );
    }
  });
});

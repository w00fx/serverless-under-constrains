// Exact line correlation (BR-RUA-047, design §8.17): every line is attributed, excluded with its
// listed reason, or unattributable with the reason that makes the check `unverified`. One case per
// disposition and per decision boundary.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAttributionContext } from '../../../src/billing-amendment/attribution-context.ts';
import type { AttributionContext } from '../../../src/billing-amendment/attribution-context.ts';
import type { CurLine } from '../../../src/billing-amendment/cur-export.ts';
import { EXCLUDED_LINE_TYPES, correlateBillingLines } from '../../../src/billing-amendment/line-attribution.ts';
import type { AttributionResult } from '../../../src/billing-amendment/line-attribution.ts';
import {
  COORDINATION_ARN,
  LEDGER_ARN,
  OTHER_RUN_ID,
  PROVIDER_ARN,
  RUN_CONTEXT,
  RUN_ID,
} from './support/cur-export-builder.ts';

function runContext(): AttributionContext {
  const parsed = parseAttributionContext(RUN_CONTEXT);
  assert.ok(parsed.ok);
  return parsed.value;
}

const CONTEXT = runContext();

const RUN_LINE: CurLine = {
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
};

function correlateOne(overrides: Partial<CurLine>): AttributionResult {
  return correlateBillingLines([{ ...RUN_LINE, ...overrides }], CONTEXT);
}

function exclusionOf(overrides: Partial<CurLine>): readonly [string, string] {
  const result = correlateOne(overrides);
  assert.deepEqual(result.lines_used, []);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.exclusions.length, 1);
  const [line] = result.exclusions;
  return [line?.exclusion ?? '', line?.detail ?? ''];
}

function unattributedDetail(overrides: Partial<CurLine>, code: string): string {
  const result = correlateOne(overrides);
  assert.deepEqual(result.lines_used, []);
  assert.deepEqual(result.exclusions, []);
  assert.deepEqual(
    result.reasons.map((reason) => [reason.code, reason.subject]),
    [[code, 'BR-RUA-047']],
  );
  return result.reasons[0]?.detail.split(';')[0] ?? '';
}

describe('correlateBillingLines attributes exact run-owned usage', () => {
  it('attributes a fully matching line with its exported cost and the window', () => {
    assert.deepEqual(correlateOne({}), {
      window: { start: '2026-10-05T10:00:00.000Z', end: '2026-10-05T12:00:00.000Z' },
      lines_used: [
        {
          line_id: 'row:1',
          product_code: 'AWSLambda',
          operation: 'Invoke',
          resource_id: PROVIDER_ARN,
          usage_start: '2026-10-05T10:00:00.000Z',
          usage_end: '2026-10-05T11:00:00.000Z',
          currency: 'USD',
          cost: '0.5',
        },
      ],
      exclusions: [],
      reasons: [],
    });
  });

  it('keeps a non-USD attributable line as exported (currency judgement is the check’s)', () => {
    const result = correlateOne({ currency: 'EUR', cost: '1.25E-5' });
    assert.deepEqual(
      result.lines_used.map((line) => [line.currency, line.cost]),
      [['EUR', '0.0000125']],
    );
    assert.deepEqual(result.reasons, []);
  });

  it('attributes a line at the window edges', () => {
    const result = correlateOne({
      resource_id: LEDGER_ARN,
      product_code: 'AmazonDynamoDB',
      operation: 'PayPerRequestThroughput',
      usage_start: '2026-10-05T11:00:00Z',
      usage_end: '2026-10-05T12:00:00Z',
    });
    assert.equal(result.lines_used.length, 1);
  });

  it('returns an empty attribution for no lines', () => {
    assert.deepEqual(correlateBillingLines([], CONTEXT), {
      window: CONTEXT.window,
      lines_used: [],
      exclusions: [],
      reasons: [],
    });
  });
});

describe('correlateBillingLines excludes and lists non-attributable lines', () => {
  it('excludes every BR-RUA-047 excluded line type before any other check', () => {
    assert.deepEqual(
      [...EXCLUDED_LINE_TYPES],
      [
        ['Tax', 'TAX'],
        ['Credit', 'CREDIT'],
        ['Refund', 'REFUND'],
        ['Discount', 'DISCOUNT'],
        ['BundledDiscount', 'DISCOUNT'],
        ['Fee', 'FEE'],
        ['RIFee', 'FEE'],
        ['SavingsPlanUpfrontFee', 'SAVINGS_PLAN'],
        ['SavingsPlanRecurringFee', 'SAVINGS_PLAN'],
        ['SavingsPlanCoveredUsage', 'SAVINGS_PLAN'],
        ['SavingsPlanNegation', 'SAVINGS_PLAN'],
      ],
    );
    for (const [lineType, exclusion] of EXCLUDED_LINE_TYPES) {
      assert.deepEqual(exclusionOf({ line_item_type: lineType, usage_account_id: '210987654321' }), [
        exclusion,
        `line type "${lineType}" is not attributable usage`,
      ]);
    }
  });

  it('excludes another account', () => {
    assert.deepEqual(exclusionOf({ usage_account_id: '210987654321' }), [
      'OTHER_ACCOUNT',
      'usage account "210987654321" is not 123456789012',
    ]);
  });

  it('excludes usage that does not touch the window', () => {
    assert.deepEqual(exclusionOf({ usage_start: '2026-10-05T09:00:00Z', usage_end: '2026-10-05T10:00:00Z' }), [
      'OUTSIDE_USAGE_WINDOW',
      'usage 2026-10-05T09:00:00.000Z to 2026-10-05T10:00:00.000Z is outside the window',
    ]);
    assert.deepEqual(
      exclusionOf({
        usage_start: '2026-10-05T12:00:00Z',
        usage_end: '2026-10-05T13:00:00Z',
        line_item_type: 'DiscountedUsage',
      })[0],
      'OUTSIDE_USAGE_WINDOW',
    );
  });

  it('excludes usage with no run identity', () => {
    assert.deepEqual(exclusionOf({ resource_id: COORDINATION_ARN, run_tag: '' }), [
      'NOT_RUN_OWNED',
      `resource "${COORDINATION_ARN}" carries no run identity`,
    ]);
    assert.deepEqual(exclusionOf({ resource_id: COORDINATION_ARN, run_tag: OTHER_RUN_ID })[0], 'NOT_RUN_OWNED');
  });

  it('excludes blank-resource usage of a service or operation the run does not own', () => {
    const expected = ['NOT_RUN_OWNED', 'blank resource id, no run tag and no run-owned operation'];
    assert.deepEqual(
      exclusionOf({ resource_id: '', run_tag: '', product_code: 'AmazonS3', operation: 'Invoke' }),
      expected,
    );
    assert.deepEqual(exclusionOf({ resource_id: '', run_tag: '', operation: 'GetFunction' }), expected);
  });
});

describe('correlateBillingLines reports what it cannot attribute', () => {
  it('blank resource id on run-owned operations or with the run tag', () => {
    assert.equal(
      unattributedDetail({ resource_id: '', run_tag: '' }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (blank resource id)',
    );
    assert.equal(
      unattributedDetail({ resource_id: '  ', product_code: 'AmazonS3' }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (blank resource id)',
    );
  });

  it('half of the identity', () => {
    assert.equal(
      unattributedDetail({ run_tag: '' }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (no matching suc:run_id tag)',
    );
    assert.equal(
      unattributedDetail({ run_tag: OTHER_RUN_ID }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (no matching suc:run_id tag)',
    );
    assert.equal(
      unattributedDetail({ resource_id: COORDINATION_ARN }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (resource not in the resource manifest)',
    );
  });

  it('a run-owned resource charged outside the allowlist', () => {
    assert.equal(
      unattributedDetail({ operation: 'GetFunction' }, 'SHARED_OR_UNOWNED_CHARGE'),
      '1 line(s): row:1 ("AWSLambda"/"GetFunction" is not a run-owned operation)',
    );
    assert.equal(
      unattributedDetail({ product_code: 'AmazonDynamoDB' }, 'SHARED_OR_UNOWNED_CHARGE'),
      '1 line(s): row:1 ("AmazonDynamoDB"/"Invoke" is not a run-owned operation)',
    );
  });

  it('a line type this import cannot classify in the run account and window', () => {
    assert.equal(
      unattributedDetail({ line_item_type: 'DiscountedUsage' }, 'SHARED_OR_UNOWNED_CHARGE'),
      '1 line(s): row:1 (line type "DiscountedUsage" cannot be assigned)',
    );
  });

  it('an unreadable or straddling usage interval', () => {
    assert.equal(
      unattributedDetail({ usage_end: 'later' }, 'INCOMPLETE_ATTRIBUTION'),
      '1 line(s): row:1 (unreadable usage interval)',
    );
    assert.equal(
      unattributedDetail(
        { usage_start: '2026-10-05T09:00:00Z', usage_end: '2026-10-05T11:00:00Z' },
        'INCOMPLETE_ATTRIBUTION',
      ),
      '1 line(s): row:1 (usage interval straddles the window)',
    );
    assert.equal(
      unattributedDetail(
        { usage_start: '2026-10-05T11:00:00Z', usage_end: '2026-10-06T00:00:00Z' },
        'INCOMPLETE_ATTRIBUTION',
      ),
      '1 line(s): row:1 (usage interval straddles the window)',
    );
  });

  it('an unreadable cost or currency, never a guessed amount (A-05)', () => {
    for (const cost of ['Infinity', 'NaN', '1e400', '-0.01', '']) {
      assert.equal(
        unattributedDetail({ cost }, 'INCOMPLETE_ATTRIBUTION'),
        `1 line(s): row:1 (unreadable cost ${JSON.stringify(cost)} "USD")`,
      );
    }
    for (const currency of ['usd', 'US', '']) {
      assert.equal(
        unattributedDetail({ currency }, 'INCOMPLETE_ATTRIBUTION'),
        `1 line(s): row:1 (unreadable cost "0.5" ${JSON.stringify(currency)})`,
      );
    }
  });

  it('matches identities exactly, including inherited member names (A-05)', () => {
    const hostile = { resource_id: 'constructor', product_code: '__proto__', operation: 'toString' };
    assert.equal(correlateOne({ ...hostile, run_tag: '' }).exclusions[0]?.exclusion, 'NOT_RUN_OWNED');
    assert.equal(correlateOne({ ...hostile, run_tag: RUN_ID }).reasons[0]?.code, 'INCOMPLETE_ATTRIBUTION');
  });

  it('aggregates many lines into one reason per code, in catalogue order', () => {
    const lines: CurLine[] = [
      { ...RUN_LINE, line_id: 'row:1', line_item_type: 'DiscountedUsage' },
      { ...RUN_LINE, line_id: 'row:2', run_tag: '' },
      { ...RUN_LINE, line_id: 'row:3' },
      { ...RUN_LINE, line_id: 'row:4', resource_id: '' },
    ];
    const result = correlateBillingLines(lines, CONTEXT);
    assert.deepEqual(
      result.reasons.map((reason) => reason.detail.split(';')[0]),
      [
        '2 line(s): row:2 (no matching suc:run_id tag), row:4 (blank resource id)',
        '1 line(s): row:1 (line type "DiscountedUsage" cannot be assigned)',
      ],
    );
    assert.deepEqual(
      result.lines_used.map((line) => line.line_id),
      ['row:3'],
    );
  });
});

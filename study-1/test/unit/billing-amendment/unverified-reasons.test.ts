// Aggregated `unverified` reasons (A-12: findings must not scale with input): one per code, the line
// count, at most five sampled lines, and the expected shape of the code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REASON_SAMPLE_LIMIT,
  quoteCell,
  sampledList,
  unverifiedReason,
  unverifiedReasons,
} from '../../../src/billing-amendment/unverified-reasons.ts';
import type { UnattributableLine } from '../../../src/billing-amendment/unverified-reasons.ts';

const EXPECTATION =
  'expected exact account, resource-manifest identity, suc:run_id tag, run-owned operation, contained interval, currency and cost';

function incomplete(count: number): readonly UnattributableLine[] {
  return Array.from({ length: count }, (_, index) => ({
    line_id: `row:${String(index + 1)}`,
    code: 'INCOMPLETE_ATTRIBUTION' as const,
    cause: 'blank resource id',
  }));
}

describe('unverifiedReasons', () => {
  it('is empty for no lines', () => {
    assert.deepEqual(unverifiedReasons([]), []);
  });

  it('names every line up to the sample limit', () => {
    assert.equal(REASON_SAMPLE_LIMIT, 5);
    const detail = unverifiedReasons(incomplete(5))[0]?.detail;
    assert.equal(
      detail,
      `5 line(s): row:1 (blank resource id), row:2 (blank resource id), row:3 (blank resource id), row:4 (blank resource id), row:5 (blank resource id); ${EXPECTATION}`,
    );
  });

  it('counts the lines past the sample limit instead of naming them', () => {
    const reasons = unverifiedReasons(incomplete(100_000));
    assert.equal(reasons.length, 1);
    assert.match(
      reasons[0]?.detail ?? '',
      /^100000 line\(s\): row:1 \(blank resource id\), .* row:5 \(blank resource id\), and 99995 more; /,
    );
  });

  it('emits one reason per code in catalogue order', () => {
    const lines: UnattributableLine[] = [
      { line_id: 'row:1', code: 'SHARED_OR_UNOWNED_CHARGE', cause: 'c1' },
      { line_id: 'row:2', code: 'INCOMPLETE_ATTRIBUTION', cause: 'c2' },
      { line_id: 'row:3', code: 'SHARED_OR_UNOWNED_CHARGE', cause: 'c3' },
    ];
    assert.deepEqual(
      unverifiedReasons(lines).map((reason) => [reason.code, reason.detail.split(';')[0]]),
      [
        ['INCOMPLETE_ATTRIBUTION', '1 line(s): row:2 (c2)'],
        ['SHARED_OR_UNOWNED_CHARGE', '2 line(s): row:1 (c1), row:3 (c3)'],
      ],
    );
  });
});

describe('sampledList', () => {
  it('names every item up to the sample limit', () => {
    assert.equal(
      sampledList([], (item: string) => item),
      '',
    );
    assert.equal(
      sampledList(['a', 'b', 'c', 'd', 'e'], (item) => item.toUpperCase()),
      'A, B, C, D, E',
    );
  });

  it('names the first five items and counts the rest', () => {
    assert.equal(
      sampledList(['a', 'b', 'c', 'd', 'e', 'f'], (item) => item),
      'a, b, c, d, e, and 1 more',
    );
    const many = Array.from({ length: 17_576 }, (_, index) => String(index));
    assert.equal(
      sampledList(many, (item) => item),
      '0, 1, 2, 3, 4, and 17571 more',
    );
  });
});

describe('unverifiedReason and quoteCell', () => {
  it('states the problem and the expected shape of each code', () => {
    assert.deepEqual(unverifiedReason('INCOMPLETE_PERIOD', 'p'), {
      code: 'INCOMPLETE_PERIOD',
      subject: 'BR-RUA-047',
      detail: 'p; expected a final billing period that contains the attribution window',
    });
    assert.equal(
      unverifiedReason('SHARED_OR_UNOWNED_CHARGE', 'p').detail,
      'p; expected only run-owned usage; no proportional allocation is made',
    );
  });

  it('quotes a cell as JSON text, bounded', () => {
    assert.equal(quoteCell('Tax'), '"Tax"');
    assert.equal(quoteCell('a"b'), '"a\\"b"');
    const arn = 'arn:aws:dynamodb:us-east-1:123456789012:table/suc-study-1-coordination';
    assert.equal(quoteCell(arn), `"${arn}"`);
    const long = 'x'.repeat(100_000);
    assert.equal(quoteCell(long), `"${'x'.repeat(199)}…[truncated]`);
  });
});

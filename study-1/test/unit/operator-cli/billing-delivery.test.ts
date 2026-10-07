// The delivery check `billing import` runs before reading a Data Exports delivery (design §8.17;
// BR-RUA-047): exactly one manifest listing exactly one delivered data file and nothing else is
// imported; any other shape is refused with one BILLING_DELIVERY_REFUSED reason; a period that
// does not contain the attribution window, or an account scope without the frozen account, is
// imported with the matching `unverified` reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UsageInterval } from '../../../src/billing-amendment/usage-window.ts';
import {
  DELIVERY_MANIFEST_MEMBERS,
  DELIVERY_MANIFEST_SUFFIX,
  checkDelivery,
} from '../../../src/operator-cli/billing-delivery.ts';
import type { DeliveryEntry } from '../../../src/operator-cli/billing-delivery.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';

const ACCOUNT = '012345678901';
const WINDOW: UsageInterval = {
  start: '2026-10-05T12:00:00.000Z' as UtcMillis,
  end: '2026-10-05T14:00:00.000Z' as UtcMillis,
};
const EXPECTATIONS = { account_id: ACCOUNT, window: WINDOW };
const MANIFEST_PATH = 'metadata/suc-cur-Manifest.json';
const DATA_PATH = 'data/BILLING_PERIOD=2026-10/suc-cur-00001.csv.gz';
const DATA_BYTES = new TextEncoder().encode('line_item_line_item_type\nUsage\n');
// Owner amendment A-05 hostile shapes: 100,000 levels of nesting, as an array and as an object.
const DEPTH = 100_000;
const DEEP_ARRAY = `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}`;
const DEEP_OBJECT = `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}`;

function manifestOf(members: Record<string, unknown>): DeliveryEntry {
  return { path: MANIFEST_PATH, bytes: new TextEncoder().encode(JSON.stringify(members)) };
}

function goodMembers(): Record<string, unknown> {
  return {
    dataFiles: [`s3://suc-cur/exports/${DATA_PATH}`],
    billingPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    account: '999999999999',
    usageAccountIds: [ACCOUNT],
  };
}

function delivery(members: Record<string, unknown> = goodMembers()): DeliveryEntry[] {
  return [manifestOf(members), { path: DATA_PATH, bytes: DATA_BYTES }];
}

function refusedDetail(entries: readonly DeliveryEntry[]): string {
  const checked = checkDelivery(entries, EXPECTATIONS);
  assert.equal(checked.ok, false, 'refused');
  assert.equal(checked.error.code, 'BILLING_DELIVERY_REFUSED');
  assert.equal(checked.error.subject, 'BR-RUA-047');
  return checked.error.detail;
}

function reasonCodes(members: Record<string, unknown>): readonly string[] {
  const checked = checkDelivery(delivery(members), EXPECTATIONS);
  assert.equal(checked.ok, true, 'accepted');
  return checked.value.reasons.map((reason) => `${reason.code}:${reason.subject}`);
}

describe('checkDelivery', () => {
  it('names the manifest members it reads in one place', () => {
    assert.equal(DELIVERY_MANIFEST_SUFFIX, 'Manifest.json');
    assert.deepEqual(DELIVERY_MANIFEST_MEMBERS, {
      dataFiles: 'dataFiles',
      billingPeriod: 'billingPeriod',
      periodStart: 'start',
      periodEnd: 'end',
      payerAccount: 'account',
      usageAccounts: 'usageAccountIds',
    });
  });

  it('accepts one manifest and its one data file with no reasons when the scope and period cover the window', () => {
    const checked = checkDelivery(delivery(), EXPECTATIONS);
    assert.equal(checked.ok, true);
    assert.equal(checked.value.manifest.path, MANIFEST_PATH);
    assert.deepEqual(checked.value.data_file, { path: DATA_PATH, bytes: DATA_BYTES });
    assert.deepEqual(checked.value.reasons, []);
  });

  it('matches a listed key equal to the delivered path and an account given as the payer', () => {
    const checked = checkDelivery(
      delivery({ ...goodMembers(), dataFiles: [DATA_PATH], account: ACCOUNT, usageAccountIds: 'none' }),
      EXPECTATIONS,
    );
    assert.equal(checked.ok, true);
    assert.equal(checked.value.data_file.path, DATA_PATH);
    assert.deepEqual(checked.value.reasons, []);
  });

  it('accepts a window that touches both period ends exactly', () => {
    const codes = reasonCodes({
      ...goodMembers(),
      billingPeriod: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-05T14:00:00Z' },
    });
    assert.deepEqual(codes, []);
  });

  it('refuses an entry that is not a regular file', () => {
    assert.equal(
      refusedDetail([...delivery(), { path: 'data/link' }]),
      'delivery entry "data/link" is not a regular file; expected regular files at normalized relative paths',
    );
  });

  it('refuses a path that cannot be stored under the export directory', () => {
    assert.equal(
      refusedDetail([...delivery(), { path: '../escape.csv', bytes: DATA_BYTES }]),
      'delivery entry "../escape.csv" cannot be stored as a package path; expected regular files at normalized relative paths',
    );
  });

  it('refuses a delivery with no manifest or with two', () => {
    assert.equal(
      refusedDetail([{ path: DATA_PATH, bytes: DATA_BYTES }]),
      '0 manifest files; expected exactly one *Manifest.json',
    );
    assert.equal(
      refusedDetail([...delivery(), { ...manifestOf(goodMembers()), path: 'other-Manifest.json' }]),
      '2 manifest files; expected exactly one *Manifest.json',
    );
  });

  it('refuses a manifest that is not one JSON object', () => {
    const expected = `"${MANIFEST_PATH}" is not one JSON object; expected a Data Exports manifest object`;
    assert.equal(
      refusedDetail([
        { path: MANIFEST_PATH, bytes: new TextEncoder().encode('[1]') },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ]),
      expected,
    );
    assert.equal(
      refusedDetail([
        { path: MANIFEST_PATH, bytes: new TextEncoder().encode('{') },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ]),
      expected,
    );
  });

  it('refuses a manifest that does not list exactly one non-empty data file key', () => {
    const cases: readonly [unknown, string][] = [
      [undefined, 'null'],
      ['data.csv', '"data.csv"'],
      [[], '[]'],
      [[1], '[1]'],
      [[''], '[""]'],
      [[DATA_PATH, DATA_PATH], `["${DATA_PATH}","${DATA_PATH}"]`],
    ];
    for (const [listed, quoted] of cases) {
      const members = { ...goodMembers(), dataFiles: listed };
      assert.equal(
        refusedDetail(delivery(members)),
        `"${MANIFEST_PATH}" member dataFiles is ${quoted}; expected an array of exactly one data file key`,
      );
    }
  });

  it('refuses a listed key that matches no delivered file, or more than one', () => {
    assert.equal(
      refusedDetail(delivery({ ...goodMembers(), dataFiles: ['s3://suc-cur/other.csv.gz'] })),
      'the listed data file "s3://suc-cur/other.csv.gz" matches 0 delivered files; expected exactly one',
    );
    assert.equal(
      refusedDetail([
        ...delivery({ ...goodMembers(), dataFiles: ['x/a/b.csv'] }),
        { path: 'a/b.csv', bytes: DATA_BYTES },
        { path: 'b.csv', bytes: DATA_BYTES },
      ]),
      'the listed data file "x/a/b.csv" matches 2 delivered files; expected exactly one',
    );
  });

  it('does not match a key that only ends with the path without a separator', () => {
    assert.equal(
      refusedDetail(delivery({ ...goodMembers(), dataFiles: [`prefix${DATA_PATH}`] })),
      `the listed data file "prefix${DATA_PATH}" matches 0 delivered files; expected exactly one`,
    );
  });

  it('refuses a delivered file the manifest does not list', () => {
    assert.equal(
      refusedDetail([...delivery(), { path: 'data/extra.csv.gz', bytes: DATA_BYTES }]),
      'delivered file "data/extra.csv.gz" is not listed; expected only the manifest and its one data file',
    );
  });

  it('demotes an unreadable billing period to INCOMPLETE_PERIOD', () => {
    const periods: readonly [unknown, string][] = [
      [undefined, 'null'],
      ['2026-10', '"2026-10"'],
      [{ start: '2026-10-01T00:00:00Z' }, '{"start":"2026-10-01T00:00:00Z"}'],
      [{ start: 1, end: '2026-11-01T00:00:00Z' }, '{"start":1,"end":"2026-11-01T00:00:00Z"}'],
      [{ start: '2026-10-01', end: '2026-11-01T00:00:00Z' }, '{"start":"2026-10-01","end":"2026-11-01T00:00:00Z"}'],
    ];
    for (const [period, quoted] of periods) {
      const checked = checkDelivery(delivery({ ...goodMembers(), billingPeriod: period }), EXPECTATIONS);
      assert.equal(checked.ok, true);
      assert.deepEqual(
        checked.value.reasons.map((reason) => [reason.code, reason.detail.split(';')[0]]),
        [
          [
            'INCOMPLETE_PERIOD',
            `the delivery manifest states its billingPeriod as ${quoted}, not as readable UTC instants`,
          ],
        ],
      );
    }
  });

  it('demotes a period that does not contain the window, at either end', () => {
    const late = checkDelivery(
      delivery({ ...goodMembers(), billingPeriod: { start: '2026-10-05T13:00:00Z', end: '2026-11-01T00:00:00Z' } }),
      EXPECTATIONS,
    );
    assert.equal(late.ok, true);
    assert.deepEqual(
      late.value.reasons.map((reason) => reason.detail.split(';')[0]),
      [
        'the delivery covers 2026-10-05T13:00:00.000Z to 2026-11-01T00:00:00.000Z, not the attribution window 2026-10-05T12:00:00.000Z to 2026-10-05T14:00:00.000Z',
      ],
    );
    assert.deepEqual(
      reasonCodes({ ...goodMembers(), billingPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-10-05T13:59:59Z' } }),
      ['INCOMPLETE_PERIOD:BR-RUA-047'],
    );
  });

  it('demotes an account scope that omits the frozen account to INCOMPLETE_ATTRIBUTION', () => {
    const checked = checkDelivery(
      delivery({ ...goodMembers(), account: '999999999999', usageAccountIds: ['111111111111'] }),
      EXPECTATIONS,
    );
    assert.equal(checked.ok, true);
    assert.deepEqual(
      checked.value.reasons.map((reason) => [reason.code, reason.detail.split(';')[0]]),
      [
        [
          'INCOMPLETE_ATTRIBUTION',
          `the delivery's account scope (account "999999999999", usageAccountIds ["111111111111"]) does not include the frozen account ${ACCOUNT}`,
        ],
      ],
    );
    const { account: _payer, usageAccountIds: _usage, ...unscoped } = goodMembers();
    const absent = checkDelivery(delivery(unscoped), EXPECTATIONS);
    assert.equal(absent.ok, true);
    assert.deepEqual(
      absent.value.reasons.map((reason) => reason.detail.split(';')[0]),
      [
        `the delivery's account scope (account null, usageAccountIds null) does not include the frozen account ${ACCOUNT}`,
      ],
    );
  });

  it('reports the period reason before the scope reason', () => {
    assert.deepEqual(reasonCodes({ ...goodMembers(), billingPeriod: null, usageAccountIds: [] }), [
      'INCOMPLETE_PERIOD:BR-RUA-047',
      'INCOMPLETE_ATTRIBUTION:BR-RUA-047',
    ]);
  });

  it('never reads an inherited member through a __proto__ or constructor name', () => {
    const bytes = new TextEncoder().encode(
      `{"__proto__":{"dataFiles":["${DATA_PATH}"]},"constructor":{"billingPeriod":1}}`,
    );
    assert.equal(
      refusedDetail([
        { path: MANIFEST_PATH, bytes },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ]),
      `"${MANIFEST_PATH}" member dataFiles is null; expected an array of exactly one data file key`,
    );
  });

  // Owner amendment A-05 (WP-28 review F5): the fuzz properties reach these shapes only through
  // fc.constantFrom; each is pinned here, with the bounded quotation its reason carries.
  it('refuses a manifest nested 100,000 levels deep without throwing', () => {
    const notObject = `"${MANIFEST_PATH}" is not one JSON object; expected a Data Exports manifest object`;
    const manifestOfText = (text: string): DeliveryEntry[] => [
      { path: MANIFEST_PATH, bytes: new TextEncoder().encode(text) },
      { path: DATA_PATH, bytes: DATA_BYTES },
    ];
    assert.equal(refusedDetail(manifestOfText(DEEP_ARRAY)), notObject);
    assert.equal(
      refusedDetail(manifestOfText(DEEP_OBJECT)),
      `"${MANIFEST_PATH}" member dataFiles is null; expected an array of exactly one data file key`,
    );
    assert.equal(
      refusedDetail(manifestOfText(`{"dataFiles":[${DEEP_ARRAY}]}`)),
      `"${MANIFEST_PATH}" member dataFiles is ${'['.repeat(QUOTED_JSON_LIMIT)}…[truncated]; expected an array of exactly one data file key`,
    );
  });

  it('refuses a manifest holding a number beyond the double range such as 1e400', () => {
    const bytes = new TextEncoder().encode(
      `{"dataFiles":["${DATA_PATH}"],"billingPeriod":{"start":1e400,"end":"2026-11-01T00:00:00Z"}}`,
    );
    assert.equal(
      refusedDetail([
        { path: MANIFEST_PATH, bytes },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ]),
      `"${MANIFEST_PATH}" is not one JSON object; expected a Data Exports manifest object`,
    );
  });

  it('demotes a billing period nested 100,000 levels deep with a bounded quotation', () => {
    const bytes = new TextEncoder().encode(
      `{"dataFiles":["${DATA_PATH}"],"billingPeriod":${DEEP_OBJECT},"usageAccountIds":["${ACCOUNT}"]}`,
    );
    const checked = checkDelivery(
      [
        { path: MANIFEST_PATH, bytes },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ],
      EXPECTATIONS,
    );
    assert.equal(checked.ok, true);
    assert.deepEqual(
      checked.value.reasons.map((reason) => [reason.code, reason.detail.split(';')[0]]),
      [
        [
          'INCOMPLETE_PERIOD',
          `the delivery manifest states its billingPeriod as ${'{"a":'.repeat(QUOTED_JSON_LIMIT / 5)}…[truncated], not as readable UTC instants`,
        ],
      ],
    );
  });

  // Fuzz regression (billing-delivery.fuzz.test.ts, FC_RUNS=10000, seed 437808079, path
  // "5503:3:2:2:2"): a manifest listing itself as the data file was imported as its own export.
  it('refuses a manifest that lists itself as the data file', () => {
    const selfListing = new TextEncoder().encode('{"dataFiles":["m-Manifest.json"]}');
    assert.equal(
      refusedDetail([{ path: 'm-Manifest.json', bytes: selfListing }]),
      'the listed data file "m-Manifest.json" matches 0 delivered files; expected exactly one',
    );
    assert.equal(
      refusedDetail([
        { path: MANIFEST_PATH, bytes: new TextEncoder().encode(`{"dataFiles":["s3://b/${MANIFEST_PATH}"]}`) },
        { path: DATA_PATH, bytes: DATA_BYTES },
      ]),
      `the listed data file "s3://b/${MANIFEST_PATH}" matches 0 delivered files; expected exactly one`,
    );
  });
});

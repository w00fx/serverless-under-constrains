// Property tests of the billing delivery check (testing rule 6; A-05 totality; BR-RUA-047): the
// delivery directory and its manifest bytes are untrusted, so over any listing and any manifest
// bytes `checkDelivery` returns without throwing, refuses with one bounded BILLING_DELIVERY_REFUSED
// reason, or accepts exactly the manifest and the one listed data file the listing holds, with
// only INCOMPLETE_PERIOD / INCOMPLETE_ATTRIBUTION reasons. Hostile manifests (deep nesting,
// `1e400`, `__proto__` and `constructor` members) are part of the space.
// Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { UsageInterval } from '../../../src/billing-amendment/usage-window.ts';
import { checkDelivery } from '../../../src/operator-cli/billing-delivery.ts';
import type { DeliveryEntry } from '../../../src/operator-cli/billing-delivery.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const MAX_DETAIL = 2_000;
const ACCOUNT = '012345678901';
const WINDOW: UsageInterval = {
  start: '2026-10-05T12:00:00.000Z' as UtcMillis,
  end: '2026-10-05T14:00:00.000Z' as UtcMillis,
};
const encoder = new TextEncoder();

const pathText = fc.oneof(
  fc.constantFrom(
    'm-Manifest.json',
    'metadata/m-Manifest.json',
    'data/part-00001.csv.gz',
    'part-00001.csv.gz',
    '../escape',
    '/abs',
    'a//b',
    '',
    'x/',
    '.',
    '__proto__',
  ),
  fc.string({ maxLength: 40 }),
);

const hostileManifest = fc.constantFrom(
  `${'['.repeat(100_000)}${']'.repeat(100_000)}`,
  `{"dataFiles":["data/part-00001.csv.gz"],"billingPeriod":{"start":1e400,"end":"2026-11-01T00:00:00Z"}}`,
  `{"__proto__":{"dataFiles":["data/part-00001.csv.gz"]},"constructor":{"account":"${ACCOUNT}"}}`,
  `{"dataFiles":["data/part-00001.csv.gz"],"dataFiles":["part-00001.csv.gz"]}`,
  '﻿{}',
  '',
);

const manifestMembers = fc.record(
  {
    dataFiles: fc.oneof(
      fc.constant(['data/part-00001.csv.gz']),
      fc.constant(['s3://bucket/x/data/part-00001.csv.gz']),
      fc.array(pathText, { maxLength: 3 }),
      fc.jsonValue({ maxDepth: 2 }),
    ),
    billingPeriod: fc.oneof(
      fc.constant({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }),
      fc.record({ start: fc.string({ maxLength: 30 }), end: fc.string({ maxLength: 30 }) }),
      fc.jsonValue({ maxDepth: 2 }),
    ),
    account: fc.oneof(fc.constant(ACCOUNT), fc.jsonValue({ maxDepth: 1 })),
    usageAccountIds: fc.oneof(fc.constant([ACCOUNT]), fc.jsonValue({ maxDepth: 2 })),
  },
  { requiredKeys: [] },
);

const manifestBytes = fc.oneof(
  manifestMembers.map((members) => encoder.encode(JSON.stringify(members))),
  hostileManifest.map((text) => encoder.encode(text)),
  fc.uint8Array({ maxLength: 64 }),
);

const entry: fc.Arbitrary<DeliveryEntry> = fc.oneof(
  fc.record({ path: pathText, bytes: fc.uint8Array({ maxLength: 16 }) }),
  fc.record({ path: pathText }),
);

const listing = fc
  .tuple(
    fc.array(fc.tuple(fc.constantFrom('m-Manifest.json', 'metadata/m-Manifest.json'), manifestBytes), {
      maxLength: 2,
    }),
    fc.array(entry, { maxLength: 4 }),
  )
  .map(([manifests, others]): DeliveryEntry[] => [...manifests.map(([path, bytes]) => ({ path, bytes })), ...others]);

describe('billing delivery totality', () => {
  it('refuses with one bounded reason or accepts exactly the manifest and its listed data file', () => {
    fc.assert(
      fc.property(listing, (entries) => {
        const checked = checkDelivery(entries, { account_id: ACCOUNT, window: WINDOW });
        if (!checked.ok) {
          assert.equal(checked.error.code, 'BILLING_DELIVERY_REFUSED');
          assert.equal(checked.error.subject, 'BR-RUA-047');
          assert.ok(checked.error.detail.length <= MAX_DETAIL, checked.error.detail.slice(0, 120));
          return;
        }
        const files = entries.filter((candidate) => candidate.bytes !== undefined);
        assert.equal(files.length, entries.length, 'every entry is a regular file');
        assert.equal(files.length, 2, 'the manifest and one data file');
        assert.ok(checked.value.manifest.path.endsWith('Manifest.json'));
        assert.notEqual(checked.value.data_file.path, checked.value.manifest.path);
        assert.ok(
          files.some(
            (file) => file.path === checked.value.data_file.path && file.bytes === checked.value.data_file.bytes,
          ),
        );
        for (const reason of checked.value.reasons) {
          assert.ok(['INCOMPLETE_PERIOD', 'INCOMPLETE_ATTRIBUTION'].includes(reason.code), reason.code);
          assert.ok(reason.detail.length <= MAX_DETAIL, reason.detail.slice(0, 120));
        }
      }),
      fuzzParameters(),
    );
  });

  it('is total over arbitrary manifest bytes beside one data file, and accepts some', () => {
    let accepted = 0;
    fc.assert(
      fc.property(manifestBytes, (bytes) => {
        const checked = checkDelivery(
          [
            { path: 'metadata/m-Manifest.json', bytes },
            { path: 'data/part-00001.csv.gz', bytes: new Uint8Array([1]) },
          ],
          { account_id: ACCOUNT, window: WINDOW },
        );
        const codes = checked.ok ? checked.value.reasons.map((reason) => reason.code) : [checked.error.code];
        assert.ok(codes.length <= 2);
        accepted += checked.ok ? 1 : 0;
      }),
      fuzzParameters(),
    );
    assert.ok(accepted > 0, 'the generator reaches accepted deliveries');
  });
});

// The durable-store suite minimums (design §12.1, D-33, Owner amendment A-03): the file exists
// and holds a minimum for every suite this feature has. §14 maps no acceptance criterion to
// durable-store (WP-04 feeds BR-RUA-053's offline storage semantics), so the floor is one case
// per suite: unit (codec, validation, classification, cursors, request planning), contract
// (the stored-item wire contract: AttributeValue descriptors and the stream filter) and integration (the adapter over
// a real SDK client and the §12.2 conformance tests of the store fakes). The committed values sit
// at the counts that exist today and only ratchet upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/durable-store.json', import.meta.url));

describe('durable-store suite minimums', () => {
  it('hold a positive minimum for the unit, contract and integration suites', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.contract ?? 0) >= 1, `contract minimum ${String(minimums.contract)}; expected >= 1`);
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
  });
});

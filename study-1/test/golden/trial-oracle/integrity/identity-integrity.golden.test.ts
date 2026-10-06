// AC-RUA-017 golden (INV-RUA-001, BR-RUA-029): reused caller identities make identity integrity
// `invalid`, missing identity evidence makes it `unverified`, and a collision of provider-generated
// identities makes evidence integrity `invalid`; each trial is `indeterminate`, and the monetary
// observations the complete ledger proves are still reported.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { integrityMismatches } from './support/integrity-golden.ts';

describe('AC-RUA-017 physical identity integrity', () => {
  it('caller-identity-reuse', async () => {
    assert.deepEqual(await integrityMismatches('caller-identity-reuse'), []);
  });
  it('missing-identity-evidence', async () => {
    assert.deepEqual(await integrityMismatches('missing-identity-evidence'), []);
  });
  it('provider-generated-collision', async () => {
    assert.deepEqual(await integrityMismatches('provider-generated-collision'), []);
  });
});

// Finding a selected-chain amendment by the digest of its amendment index (design §8.16 step 6).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { selectedAmendment } from '../../../src/variant-validation/selected-amendment.ts';
import { digest } from '../../support/record-contract/record-builders.ts';
import { recoveryAmendment } from '../../golden/variant-validation/support/validation-amendments.ts';
import { CLEAN_CLOSURE, validationPackage } from '../../golden/variant-validation/support/validation-package.ts';

describe('selectedAmendment', () => {
  const fixture = validationPackage({ closure: { ...CLEAN_CLOSURE, cleanup_status: 'partial' } });
  const recovery = recoveryAmendment(fixture, CLEAN_CLOSURE);
  const noIndex = { directory: '0002-stray', files: [], special_entries: [] };

  it('finds the amendment whose index bytes hash to the digest, skipping directories without an index', () => {
    assert.equal(selectedAmendment(recovery.index_sha256, [noIndex, recovery.snapshot], sha256Hex), recovery.snapshot);
  });

  it('finds nothing for an unknown digest', () => {
    assert.equal(selectedAmendment(digest('unknown amendment'), [recovery.snapshot], sha256Hex), undefined);
  });
});

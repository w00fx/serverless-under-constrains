// AC-RUA-041 golden (BR-RUA-008, BR-RUA-029): a verdict-critical record that cannot be correlated
// to the active execution makes traceability `unverified` when its correlation is missing and
// `invalid` when it names another trial; preservation is `indeterminate`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { integrityMismatches } from './support/integrity-golden.ts';

describe('AC-RUA-041 untraceable verdict-critical records', () => {
  it('missing-execution-identity', async () => {
    assert.deepEqual(await integrityMismatches('missing-execution-identity'), []);
  });
  it('other-trial-identity', async () => {
    assert.deepEqual(await integrityMismatches('other-trial-identity'), []);
  });
  it('unresolved-causal-predecessor', async () => {
    assert.deepEqual(await integrityMismatches('unresolved-causal-predecessor'), []);
  });
});

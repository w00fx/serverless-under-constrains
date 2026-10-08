// AC-RUA-018 and AC-RUA-029 goldens (BR-RUA-006, BR-RUA-025): clean CONTROL evidence verifies
// control integrity; treatment armed, treatment consumed or an uncontrolled timeout in a CONTROL
// trial makes it `invalid`, and preservation `indeterminate`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { integrityMismatches } from './support/integrity-golden.ts';

describe('AC-RUA-018 control integrity verified', () => {
  it('ac018-clean-control', async () => {
    assert.deepEqual(await integrityMismatches('ac018-clean-control'), []);
  });
});

describe('AC-RUA-029 control integrity invalid', () => {
  it('treatment-armed', async () => {
    assert.deepEqual(await integrityMismatches('treatment-armed'), []);
  });
  it('treatment-consumed', async () => {
    assert.deepEqual(await integrityMismatches('treatment-consumed'), []);
  });
  it('uncontrolled-timeout', async () => {
    assert.deepEqual(await integrityMismatches('uncontrolled-timeout'), []);
  });
});

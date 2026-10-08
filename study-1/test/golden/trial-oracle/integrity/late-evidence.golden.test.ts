// AC-RUA-030 golden (BR-RUA-031, BR-RUA-043, D-16): correlated activity after the final freeze is
// preserved as late evidence and assessed by re-evaluating the frozen evidence with it; the frozen
// result and the original digests stay unchanged; consistent late evidence leaves comparison
// possible and contradictory late evidence blocks it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lateEvidenceMismatches } from './support/late-evidence-golden.ts';

describe('AC-RUA-030 late evidence after freeze', () => {
  it('consistent', async () => {
    assert.deepEqual(await lateEvidenceMismatches('consistent'), []);
  });
  it('contradictory', async () => {
    assert.deepEqual(await lateEvidenceMismatches('contradictory'), []);
  });
});

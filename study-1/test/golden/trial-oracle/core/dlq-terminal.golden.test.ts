// AC-RUA-052 golden (BR-RUA-029, -030): an exact effect whose processing ends in the dead-letter
// queue passes, with terminal reason RETRIES_EXHAUSTED and correct_completion false.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-052 exact effect with non-successful terminal processing', () => {
  it('exact-effect-dlq-terminal', async () => {
    assert.deepEqual(await coreMismatches('exact-effect-dlq-terminal'), []);
  });
});

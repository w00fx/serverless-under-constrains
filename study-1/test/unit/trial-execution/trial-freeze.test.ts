// The `settlement_assessed` body the runner journals (BR-RUA-032): the evaluator's judgement with
// the number of samples it was made from, in the schema's two shapes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { settlementAssessedBody } from '../../../src/trial-execution/trial-freeze.ts';
import type { TrialFreezeInput } from '../../../src/trial-execution/trial-freeze.ts';

const AT = '2026-10-05T12:07:00.000Z' as UtcMillis;
const restarts = [{ at: AT, cause: 'SOURCE_VISIBLE' as const }];

function input(assessment: TrialFreezeInput['assessment'], rounds: number): TrialFreezeInput {
  return {
    collection: { files: [], failures: [], ledger_complete: true },
    rounds: Array.from({ length: rounds }, () => ({}) as TrialFreezeInput['rounds'][number]),
    assessment,
  };
}

describe('settlementAssessedBody', () => {
  it('carries an established window with no reasons', () => {
    const body = settlementAssessedBody(
      input({ status: 'established', window_start: AT, established_at: AT, rechecked_at: AT, restarts }, 7),
    );
    assert.deepEqual(body, {
      status: 'established',
      window_start: AT,
      established_at: AT,
      rechecked_at: AT,
      reasons: [],
      restarts,
      sample_count: 7,
    });
  });

  it('carries the reasons of an unestablished judgement', () => {
    const reasons = [{ code: 'DEADLINE', subject: 'BR-RUA-032', detail: 'no quiet window' }];
    const body = settlementAssessedBody(input({ status: 'not_established', reasons, restarts: [] }, 20));
    assert.deepEqual(body, { status: 'not_established', reasons, restarts: [], sample_count: 20 });
  });
});

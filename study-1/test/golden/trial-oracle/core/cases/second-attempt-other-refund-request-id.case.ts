// AC-RUA-039 (BR-RUA-003): "a retry attempt that carries a refund_request_id other than the
// original; BR-RUA-003 fails; preservation is fail." In the conventional treatment trial the first
// delivery's attempt carries `ref-poc-001` and times out after its targeted commit; the
// redelivery's attempt carries `ref-poc-002` and succeeds, so the attempt journal changes the
// logical identity between attempts.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'second-attempt-other-refund-request-id',
  ac_ids: ['AC-RUA-039'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-003', outcome: 'fail' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-conventional-treatment',
  plan: {
    deliveries: [
      { attempts: [{ behavior: 'targeted_timeout' }] },
      { attempts: [{ behavior: 'succeeded', refund_request_id: 'ref-poc-002' }] },
    ],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-003': 'fail' },
    projection: { refund_request_ids: ['ref-poc-001', 'ref-poc-002'] },
  },
});

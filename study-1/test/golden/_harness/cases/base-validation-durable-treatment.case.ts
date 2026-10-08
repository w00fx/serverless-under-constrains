// Golden harness base: a Durable variant validation's second trial (BR-RUA-038):
// COMMIT_THEN_TIMEOUT. Its expected values are the spec's Expected Configured Trace row
// COMMIT_THEN_TIMEOUT / Durable, plus the settlement a nominal workload reaches before its deadline
// (BR-RUA-032) and the terminal treatment state of BR-RUA-025. It reaches no rule outcome: the
// oracle cases that start from this base state those.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'base-validation-durable-treatment',
  ac_ids: [],
  rule_outcomes_reached: [],
  base: 'validation-durable-treatment',
  expected: {
    subject: { caller: 'durable', scenario: 'COMMIT_THEN_TIMEOUT' },
    configured_trace: {
      published_messages: 1,
      source_deliveries: 1,
      provider_calls: 2,
      durable_attempts: 2,
      successful_transactions: 2,
    },
    treatment_final_state: 'RESPONSE_RELEASED',
    settlement_status: 'established',
    processing_terminal_reason: 'SUCCEEDED',
  },
});

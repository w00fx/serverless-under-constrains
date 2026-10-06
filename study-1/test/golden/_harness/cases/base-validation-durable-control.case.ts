// Golden harness base: a Durable variant validation's first trial (BR-RUA-038): CONTROL. Its
// expected values are the spec's Expected Configured Trace row CONTROL / Durable, plus the
// settlement a nominal workload reaches before its deadline (BR-RUA-032) and the terminal treatment
// state of BR-RUA-025. It reaches no rule outcome: the oracle cases that start from this base state
// those.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'base-validation-durable-control',
  ac_ids: [],
  rule_outcomes_reached: [],
  base: 'validation-durable-control',
  expected: {
    subject: { caller: 'durable', scenario: 'CONTROL' },
    configured_trace: {
      published_messages: 1,
      source_deliveries: 1,
      provider_calls: 1,
      durable_attempts: 1,
      successful_transactions: 1,
    },
    treatment_final_state: null,
    settlement_status: 'established',
    processing_terminal_reason: 'SUCCEEDED',
  },
});

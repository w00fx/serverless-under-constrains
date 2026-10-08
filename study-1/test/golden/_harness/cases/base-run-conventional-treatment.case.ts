// Golden harness base: the canonical run's third trial (BR-RUA-019): conventional
// COMMIT_THEN_TIMEOUT. Its expected values are the spec's Expected Configured Trace row
// COMMIT_THEN_TIMEOUT / Conventional; design §9.12 conventional sequence, plus the settlement a
// nominal workload reaches before its deadline (BR-RUA-032) and the terminal treatment state of BR-
// RUA-025. It reaches no rule outcome: the oracle cases that start from this base state those.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'base-run-conventional-treatment',
  ac_ids: [],
  rule_outcomes_reached: [],
  base: 'run-conventional-treatment',
  expected: {
    subject: { caller: 'conventional', scenario: 'COMMIT_THEN_TIMEOUT' },
    configured_trace: {
      published_messages: 1,
      source_deliveries: 2,
      provider_calls: 2,
      durable_attempts: null,
      successful_transactions: 2,
    },
    treatment_final_state: 'RESPONSE_RELEASED',
    settlement_status: 'established',
    processing_terminal_reason: 'SUCCEEDED',
  },
});

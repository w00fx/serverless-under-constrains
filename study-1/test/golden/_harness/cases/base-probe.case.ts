// Golden harness base: the transport probe (BR-RUA-027): one synchronous invocation and one attempt
// through the treatment sequence, no retry. Its expected values come from the design §9.12 probe
// sequence, plus the settlement a nominal workload reaches before its deadline (BR-RUA-032) and the
// terminal treatment state of BR-RUA-025. It reaches no rule outcome: the oracle cases that start
// from this base state those.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'base-probe',
  ac_ids: [],
  rule_outcomes_reached: [],
  base: 'probe',
  expected: {
    subject: { caller: 'probe', scenario: 'COMMIT_THEN_TIMEOUT' },
    configured_trace: {
      published_messages: 0,
      source_deliveries: 0,
      provider_calls: 1,
      durable_attempts: null,
      successful_transactions: 1,
    },
    treatment_final_state: 'RESPONSE_RELEASED',
    settlement_status: 'established',
    processing_terminal_reason: null,
  },
});

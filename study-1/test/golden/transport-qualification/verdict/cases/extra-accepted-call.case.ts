// AC-RUA-032 case: an additional accepted provider call. The probe invocation makes a second
// attempt after its targeted one, which the provider accepts and commits. Expected from BR-RUA-027
// ('an additional accepted provider call or transaction makes probe_validity invalid and therefore
// makes the transport verdict indeterminate'): two accepted calls, two transactions, validity
// `invalid`, verdict `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'extra-accepted-call',
  ac_ids: ['AC-RUA-032'],
  rule_outcomes_reached: [{ rule_id: 'BR-RUA-027', outcome: 'indeterminate' }],
  base: 'probe',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'succeeded' }] }],
    processing: 'completes',
  },
  expected: {
    transport_probe_verdict: 'indeterminate',
    probe_validity: 'invalid',
    probe_cardinality: { caller_invocations: 1, accepted_provider_calls: 2, committed_transactions: 2 },
  },
});

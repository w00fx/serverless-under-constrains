// AC-RUA-031 case BR-RUA-012: the provider stopped after the caller aborted. Its journal ends at
// the commit confirmation (no timeout observation, no release, no safety release) and the
// consistent treatment snapshot shows the barrier still TIMEOUT_SIGNALLED. Expected from
// BR-RUA-012 ('the provider must continue executing after the caller aborts') and design §8.10:
// the condition fails, the verdict is `fail`, fidelity is invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br012-provider-stopped',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-012', outcome: 'fail' },
    { rule_id: 'BR-RUA-013', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-014', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'remove_record',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'treatment_response_released' },
    },
    {
      op: 'remove_record',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'treatment_timeout_observed' },
    },
    {
      op: 'set',
      path: '$trial/state/treatment-state-snapshot.json',
      pointer: '/treatment/state',
      value: 'TIMEOUT_SIGNALLED',
    },
    { op: 'set', path: '$trial/state/treatment-state-snapshot.json', pointer: '/treatment/version', value: 3 },
    { op: 'remove', path: '$trial/state/treatment-state-snapshot.json', pointer: '/treatment/observed_event_id' },
    { op: 'remove', path: '$trial/state/treatment-state-snapshot.json', pointer: '/treatment/release_event_id' },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-012': 'fail' }, treatment_fidelity: 'invalid' },
});

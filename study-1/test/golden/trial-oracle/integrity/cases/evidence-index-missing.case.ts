// AC-RUA-055 rule coverage, `evidence_integrity` unverified (BR-RUA-034): the clean CONTROL trial
// re-evaluated as a frozen package whose evidence index lists nothing. Re-evaluation checks every
// byte against the index; an empty index vouches for none, so evidence integrity is `unverified`
// and the trial indeterminate. The case module names the index it is re-evaluated against
// (`export const indexed_digests`), as the late-evidence reassessment passes it.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

/** The re-evaluation's evidence index: package path to SHA-256, here empty. */
export const indexed_digests: Readonly<Record<string, string>> = {};

export default defineGoldenCase({
  case_id: 'evidence-index-missing',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'evidence_integrity', outcome: 'unverified' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { evidence_integrity: 'unverified' },
    gate_reason_codes: { evidence_integrity: ['EVIDENCE_INDEX_MISSING'] },
  },
});

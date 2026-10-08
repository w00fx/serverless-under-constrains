// AC-RUA-007 case 3 (BR-RUA-006, -029, -032): "verdict-critical evidence is missing; affected rule
// checks are indeterminate; preservation is indeterminate; structured reasons identify the missing
// evidence." The CONTROL trial's caller journal, which the trial manifest expects, is absent. Rule
// evidence (G7) cannot be verified, the journal rules BR-RUA-003 and -004 are indeterminate, and
// the reasons name the caller journal as missing.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac007-caller-journal-absent',
  ac_ids: ['AC-RUA-007'],
  rule_outcomes_reached: [
    { rule_id: 'rule_evidence', outcome: 'unverified' },
    { rule_id: 'BR-RUA-003', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-004', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [{ op: 'delete_file', path: '$trial/journals/caller-journal.jsonl' }],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { rule_evidence: 'unverified' },
    gate_reason_codes: { rule_evidence: ['ARTIFACT_MISSING'] },
    rules: { 'BR-RUA-003': 'indeterminate', 'BR-RUA-004': 'indeterminate' },
    rule_reason_codes: { 'BR-RUA-003': ['ARTIFACT_MISSING'], 'BR-RUA-004': ['ARTIFACT_MISSING'] },
    reason_codes_by_artifact: { '$trial/journals/caller-journal.jsonl': ['ARTIFACT_MISSING'] },
  },
});

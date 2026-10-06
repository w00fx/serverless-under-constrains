// AC-RUA-010 case 3 (BR-RUA-043, BR-RUA-044): the evidence index excludes itself and the
// late-evidence area. The frozen package also holds the files of the three earlier trials and the
// execution-wide journals and summary; none of them is in the subject trial's scope (design §7
// index scopes), so the index holds exactly the 25 in-scope files.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { EXPECTED_EXCLUSIONS, FROZEN_TRIAL_BASE, FROZEN_TRIAL_OPERATIONS } from '../support/frozen-trial-package.ts';

export default defineGoldenCase({
  case_id: 'ac010-excludes-self-and-late-evidence',
  ac_ids: ['AC-RUA-010'],
  rule_outcomes_reached: [],
  base: FROZEN_TRIAL_BASE,
  operations: FROZEN_TRIAL_OPERATIONS,
  expected: {
    excluded: [...EXPECTED_EXCLUSIONS],
    excluded_prefixes: ['late-evidence/'],
    entry_count: 25,
  },
});

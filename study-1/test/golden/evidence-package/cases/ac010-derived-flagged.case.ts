// AC-RUA-010 case 2 (BR-RUA-037): in the same frozen trial, the derived artifacts (the attempt
// projection and the oracle result) are indexed by exact bytes like every other file, and their
// entries say `derived`, so they remain distinguishable from primary evidence; every other entry
// says `primary`.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import {
  EXPECTED_INDEX_ROWS,
  FROZEN_TRIAL_BASE,
  FROZEN_TRIAL_OPERATIONS,
  rowsAsJson,
} from '../support/frozen-trial-package.ts';

export default defineGoldenCase({
  case_id: 'ac010-derived-flagged',
  ac_ids: ['AC-RUA-010'],
  rule_outcomes_reached: [],
  base: FROZEN_TRIAL_BASE,
  operations: FROZEN_TRIAL_OPERATIONS,
  expected: {
    rows: rowsAsJson(EXPECTED_INDEX_ROWS.filter((row) => row.derivation === 'derived')),
    primary_count: 23,
  },
});

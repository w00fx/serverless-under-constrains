// AC-RUA-010 case 1 (BR-RUA-008, BR-RUA-035, BR-RUA-037, BR-RUA-043): when the canonical run's
// Durable COMMIT_THEN_TIMEOUT trial reaches evidence freeze, its evidence index lists every
// applicable verdict-critical manifest, input, journal, provider event, ledger snapshot, queue
// observation, conditional DLQ snapshot and authoritative execution record by its exact bytes:
// one entry per file of the trial directory and per execution-level core file (design §7), each
// with its class and the byte count and SHA-256 of the stored bytes (BR-RUA-033).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import {
  EXPECTED_INDEX_ROWS,
  FROZEN_TRIAL_BASE,
  FROZEN_TRIAL_OPERATIONS,
  rowsAsJson,
} from '../support/frozen-trial-package.ts';

export default defineGoldenCase({
  case_id: 'ac010-primary-classes-exact-bytes',
  ac_ids: ['AC-RUA-010'],
  rule_outcomes_reached: [],
  base: FROZEN_TRIAL_BASE,
  operations: FROZEN_TRIAL_OPERATIONS,
  expected: {
    index_scope: 'TRIAL',
    rows: rowsAsJson(EXPECTED_INDEX_ROWS.filter((row) => row.derivation === 'primary')),
  },
});

// AC-RUA-047 case 8 (BR-RUA-034): "Core-file digest mismatch makes evidence integrity invalid."
// The frozen trial manifest pins a payment digest that is not the digest of the payment file's
// bytes. Expected: CORE_FILE_DIGEST_MISMATCH and evidence integrity invalid; the manifest
// reference resolves to a different digest, so traceability is invalid too (design §8.3 G2).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'core-file-digest-mismatch',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/trial-manifest.json',
      pointer: '/payment_sha256',
      value: 'abababababababababababababababababababababababababababababababab',
    },
  ],
  expected: {
    finding_codes: ['CORE_FILE_DIGEST_MISMATCH'],
    gates: { traceability: 'invalid', evidence_integrity: 'invalid' },
  },
});

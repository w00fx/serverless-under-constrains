// The closed reason vocabulary of the validation status and its verifier.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VALIDATION_REASON_CODES, validationReason } from '../../../src/variant-validation/validation-reasons.ts';

describe('validationReason', () => {
  it('builds a structured reason, with the artifact path only when one is given', () => {
    assert.deepEqual(validationReason('CLEANUP_NOT_SUCCEEDED', 'cleanup_status', 'partial; expected succeeded'), {
      code: 'CLEANUP_NOT_SUCCEEDED',
      subject: 'cleanup_status',
      detail: 'partial; expected succeeded',
    });
    assert.deepEqual(validationReason('ADMISSION_INVALID', 'admission', 'd', 'admission/source-provenance.json'), {
      code: 'ADMISSION_INVALID',
      subject: 'admission',
      artifact_path: 'admission/source-provenance.json',
      detail: 'd',
    });
  });

  it('has unique UPPER_SNAKE codes', () => {
    assert.equal(new Set(VALIDATION_REASON_CODES).size, VALIDATION_REASON_CODES.length);
    for (const code of VALIDATION_REASON_CODES) {
      assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    }
  });
});

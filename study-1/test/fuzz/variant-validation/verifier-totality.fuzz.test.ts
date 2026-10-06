// The CTR-RUA-004 verifier is total over hostile package bytes (Owner amendment A-05; AC-RUA-046
// feed) and never concludes on altered evidence (BR-RUA-044, AC-RUA-037): replacing or bit-flipping
// any stored file of a verified validation package never throws, and whenever it changes the bytes,
// the result is an error or a valid verification whose effective status is not `verified`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { verifyVariantValidation } from '../../../src/variant-validation/variant-validation-verifier.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { GOLDEN_VALIDATION_ID, goldenAt } from '../../golden/variant-validation/support/validation-records.ts';

const SOUND = validationPackage();
const encoder = new TextEncoder();

function assertNeverVerified(files: readonly PackageFile[]): void {
  const result = verifyVariantValidation(
    {
      variant_validation_id: GOLDEN_VALIDATION_ID,
      original: { files, special_entries: [] },
      amendments: [],
      selected_head: null,
      referenced_package_indexes: [],
      checked_at: goldenAt(30_000),
    },
    FIXTURE_DEPS,
  );
  if (!result.ok) {
    return;
  }
  assert.notEqual(result.value.effective_implementation_validation_status, 'verified');
  const checked = FIXTURE_DEPS.validator.validateAs(
    'variant_validation_verification',
    JSON.parse(JSON.stringify(result.value)) as JsonValue,
  );
  assert.equal(checked.valid, true);
}

function replaced(index: number, bytes: Uint8Array): readonly PackageFile[] {
  return SOUND.files.map((file, position) => (position === index ? { path: file.path, bytes } : file));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, position) => byte === b[position]);
}

const FILE_INDEX = fc.nat({ max: SOUND.files.length - 1 });
const SUMMARY_INDEX = SOUND.files.findIndex((file) => file.path === EXECUTION_PATHS.validationSummary);

describe('verifyVariantValidation over hostile bytes (property)', () => {
  it('the sound fixture verifies', () => {
    const result = verifyVariantValidation(
      {
        variant_validation_id: GOLDEN_VALIDATION_ID,
        original: { files: SOUND.files, special_entries: [] },
        amendments: [],
        selected_head: null,
        referenced_package_indexes: [],
        checked_at: goldenAt(30_000),
      },
      FIXTURE_DEPS,
    );
    assert.ok(result.ok && result.value.effective_implementation_validation_status === 'verified');
  });

  it('flipping bits of any stored byte never yields verified', () => {
    fc.assert(
      fc.property(FILE_INDEX, fc.nat(), fc.integer({ min: 1, max: 255 }), (index, offset, mask) => {
        const original = SOUND.files[index]?.bytes ?? new Uint8Array();
        const bytes = original.slice();
        bytes[offset % bytes.length] = (bytes[offset % bytes.length] ?? 0) ^ mask;
        assertNeverVerified(replaced(index, bytes));
      }),
      fuzzParameters(),
    );
  });

  it('replacing any stored file with arbitrary bytes never throws and never yields verified', () => {
    fc.assert(
      fc.property(FILE_INDEX, fc.uint8Array({ maxLength: 512 }), (index, bytes) => {
        fc.pre(!sameBytes(bytes, SOUND.files[index]?.bytes ?? new Uint8Array()));
        assertNeverVerified(replaced(index, bytes));
      }),
      fuzzParameters(),
    );
  });

  it('replacing the summary with any JSON document never throws and never yields verified', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        assertNeverVerified(replaced(SUMMARY_INDEX, encoder.encode(JSON.stringify(value))));
      }),
      fuzzParameters(),
    );
  });
});

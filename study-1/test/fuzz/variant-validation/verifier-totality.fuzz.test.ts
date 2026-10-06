// The CTR-RUA-004 verifier is total over hostile package bytes (Owner amendment A-05; AC-RUA-046
// feed) and never concludes on altered evidence (BR-RUA-044, AC-RUA-037): replacing or bit-flipping
// any stored file of a verified validation package never throws, and whenever it changes the bytes,
// the result is an error or a valid verification that does not conclude `verified` about the
// original package. The package index is the trust root: an altered index that still seals every
// file (a bit flip in its own `created_at`) is a different package, so a `verified` result is only
// acceptable when it pins that altered index's digest, never the original one (BR-RUA-035). The
// FC_RUNS=10000 campaign found that case (seed -1827406168, path "8338:8:6:7", counterexample
// [35,15,1]); its regression is the unit test "pins a re-sealed package index to its own digest".

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

function assertNoVerdictOnOriginal(files: readonly PackageFile[]): void {
  const storedIndex = files.find((file) => file.path === EXECUTION_PATHS.packageIndex)?.bytes ?? new Uint8Array();
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
  if (result.value.effective_implementation_validation_status === 'verified') {
    assert.notEqual(result.value.original_package_index_sha256, SOUND.index_sha256, 'verified the original package');
    assert.equal(result.value.original_package_index_sha256, FIXTURE_DEPS.digest(storedIndex));
  }
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

  it('flipping bits of any stored byte never verifies the original package', () => {
    fc.assert(
      fc.property(FILE_INDEX, fc.nat(), fc.integer({ min: 1, max: 255 }), (index, offset, mask) => {
        const original = SOUND.files[index]?.bytes ?? new Uint8Array();
        const bytes = original.slice();
        bytes[offset % bytes.length] = (bytes[offset % bytes.length] ?? 0) ^ mask;
        assertNoVerdictOnOriginal(replaced(index, bytes));
      }),
      fuzzParameters(),
    );
  });

  it('replacing any stored file with arbitrary bytes never throws and never verifies the original package', () => {
    fc.assert(
      fc.property(FILE_INDEX, fc.uint8Array({ maxLength: 512 }), (index, bytes) => {
        fc.pre(!sameBytes(bytes, SOUND.files[index]?.bytes ?? new Uint8Array()));
        assertNoVerdictOnOriginal(replaced(index, bytes));
      }),
      fuzzParameters(),
    );
  });

  it('replacing the summary with any JSON document never throws and never verifies the original package', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        assertNoVerdictOnOriginal(replaced(SUMMARY_INDEX, encoder.encode(JSON.stringify(value))));
      }),
      fuzzParameters(),
    );
  });
});

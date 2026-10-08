// The CTR-RUA-004 verifier is total over hostile package bytes (Owner amendment A-05; AC-RUA-046
// feed) and never concludes on altered evidence (BR-RUA-044, AC-RUA-037): replacing or bit-flipping
// any stored file of a verified validation package never throws, and whenever it changes the bytes,
// the result is an error or a valid verification that does not conclude `verified` about the
// original package. The package index is the trust root: an altered index that still seals every
// file (a bit flip in its own `created_at`) is a different package, so a `verified` result is only
// acceptable when it pins that altered index's digest, never the original one (BR-RUA-035). The
// FC_RUNS=10000 campaign found that case (seed -1827406168, path "8338:8:6:7", counterexample
// [35,15,1]); its regression is the unit test "pins a re-sealed package index to its own digest".
//
// Every reference a verification cites names a stored file by the digest of its bytes. A summary
// re-sealed with other claims (statuses from their vocabularies, oracle-result references drawn
// from the stored results) concludes `verified` only when every claim is the sound package's: the
// verifier reads the evidence and compares the claims with it, never the other way round.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  IMPLEMENTATION_VALIDATION_STATUSES,
  LATE_EVIDENCE_STATUSES,
  TRIAL_VALIDITIES,
} from '../../../src/record-contract/records/group-c/vocabulary.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { verifyVariantValidation } from '../../../src/variant-validation/variant-validation-verifier.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { reindexed, validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { GOLDEN_VALIDATION_ID, goldenAt } from '../../golden/variant-validation/support/validation-records.ts';
import { editRecord } from '../../unit/variant-validation/support/package-edits.ts';
import type { RecordMembers } from '../../unit/variant-validation/support/package-edits.ts';

const SOUND = validationPackage();
const encoder = new TextEncoder();

type Verification = ReturnType<typeof verifyVariantValidation>;

function verificationOf(files: readonly PackageFile[]): Verification {
  return verifyVariantValidation(
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
}

// An error, or a schema-valid record whose every reference names a stored file by its digest.
function assertWellFormed(files: readonly PackageFile[], result: Verification): void {
  if (!result.ok) {
    return;
  }
  const checked = FIXTURE_DEPS.validator.validateAs(
    'variant_validation_verification',
    JSON.parse(JSON.stringify(result.value)) as JsonValue,
  );
  assert.equal(checked.valid, true, JSON.stringify(checked.valid ? [] : checked.violations.slice(0, 2)));
  for (const ref of result.value.evidence_refs) {
    const stored = files.find((file) => file.path === ref.artifact_path);
    assert.ok(stored, `cites ${ref.artifact_path}, which is not stored`);
    assert.equal(
      FIXTURE_DEPS.digest(stored.bytes),
      ref.artifact_sha256,
      `cites ${ref.artifact_path} by another digest`,
    );
  }
}

function assertNoVerdictOnOriginal(files: readonly PackageFile[]): void {
  const storedIndex = files.find((file) => file.path === EXECUTION_PATHS.packageIndex)?.bytes ?? new Uint8Array();
  const result = verificationOf(files);
  assertWellFormed(files, result);
  if (!result.ok) {
    return;
  }
  if (result.value.effective_implementation_validation_status === 'verified') {
    assert.notEqual(result.value.original_package_index_sha256, SOUND.index_sha256, 'verified the original package');
    assert.equal(result.value.original_package_index_sha256, FIXTURE_DEPS.digest(storedIndex));
  }
}

function replaced(index: number, bytes: Uint8Array): readonly PackageFile[] {
  return SOUND.files.map((file, position) => (position === index ? { path: file.path, bytes } : file));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, position) => byte === b[position]);
}

const FILE_INDEX = fc.nat({ max: SOUND.files.length - 1 });
const SUMMARY_INDEX = SOUND.files.findIndex((file) => file.path === EXECUTION_PATHS.validationSummary);
const STORED_RESULT_REFS = SOUND.summary.trial_results.flatMap((entry) =>
  'oracle_result_ref' in entry ? [entry.oracle_result_ref] : [],
);

/** The claims a re-sealed summary may make about the evidence it summarizes. */
interface SummaryClaims {
  readonly implementation_validation_status: (typeof IMPLEMENTATION_VALIDATION_STATUSES)[number];
  readonly validation_validity: (typeof TRIAL_VALIDITIES)[number];
  readonly safety_status: 'within_limits' | 'breached' | 'unverified';
  readonly late_evidence_status: (typeof LATE_EVIDENCE_STATUSES)[number];
  /** Positions in STORED_RESULT_REFS each trial entry claims as its result. */
  readonly result_refs: readonly [number, number];
}

const SOUND_CLAIMS: SummaryClaims = {
  implementation_validation_status: 'verified',
  validation_validity: 'valid',
  safety_status: 'within_limits',
  late_evidence_status: 'none',
  result_refs: [0, 1],
};

const claimsArbitrary: fc.Arbitrary<SummaryClaims> = fc.record({
  implementation_validation_status: fc.constantFrom(...IMPLEMENTATION_VALIDATION_STATUSES),
  validation_validity: fc.constantFrom(...TRIAL_VALIDITIES),
  safety_status: fc.constantFrom('within_limits', 'breached', 'unverified'),
  late_evidence_status: fc.constantFrom(...LATE_EVIDENCE_STATUSES),
  result_refs: fc.tuple(fc.nat({ max: 1 }), fc.nat({ max: 1 })),
});

// The sound package with its summary re-sealed under `claims`: an edited summary, re-indexed so the
// package stays eligible. A claim the summary schema forbids makes the verifier return an error.
function claimedPackage(claims: SummaryClaims): readonly PackageFile[] {
  const edit = (summary: RecordMembers): RecordMembers => ({
    ...summary,
    implementation_validation_status: claims.implementation_validation_status,
    validation_validity: claims.validation_validity,
    safety_status: claims.safety_status,
    late_evidence_status: claims.late_evidence_status,
    status_reasons:
      claims.implementation_validation_status === 'verified'
        ? []
        : [{ code: 'CLAIMED', subject: 'validation summary', detail: 'claimed by the fuzz case' }],
    trial_results: (summary['trial_results'] as readonly RecordMembers[]).map((entry, position) => ({
      ...entry,
      oracle_result_ref: STORED_RESULT_REFS[claims.result_refs[position] ?? position],
    })),
  });
  return reindexed(SOUND, editRecord(SOUND.files, EXECUTION_PATHS.validationSummary, edit)).files;
}

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

  it('a re-sealed summary verifies only when every claim it makes is the sound one', () => {
    assert.ok(verificationOf(claimedPackage(SOUND_CLAIMS)).ok, 'the sound claims re-seal to a readable summary');
    fc.assert(
      fc.property(claimsArbitrary, (claims) => {
        const files = claimedPackage(claims);
        const result = verificationOf(files);
        assertWellFormed(files, result);
        if (result.ok && result.value.effective_implementation_validation_status === 'verified') {
          // fc.record builds null-prototype objects; compare the claims as plain values.
          assert.deepEqual({ ...claims, result_refs: [...claims.result_refs] }, SOUND_CLAIMS);
        }
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

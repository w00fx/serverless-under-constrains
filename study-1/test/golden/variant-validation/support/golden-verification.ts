// Running the CTR-RUA-004 verifier over a golden package the way the operator would: the package
// and its amendments are written once to the evidence file system, read back through the port, and
// verified with the selected head. The file system is kept so a golden can show the verifier left
// every original byte as it was (AC-RUA-026).

import assert from 'node:assert/strict';

import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { VariantValidationVerification } from '../../../../src/record-contract/records/group-c/variant_validation_verification.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import { readAmendmentSnapshots, readPackageSnapshot } from '../../../../src/evidence-package/package-snapshot.ts';
import type { PackageSnapshot } from '../../../../src/evidence-package/package-verifier.ts';
import { verifyVariantValidation } from '../../../../src/variant-validation/variant-validation-verifier.ts';
import { MemoryPackageFileSystem } from '../../../support/evidence-package/memory-package-file-system.ts';
import { FIXTURE_DEPS, unwrap } from '../../../support/evidence-package/probe-package-fixtures.ts';
import { GOLDEN_IDENTITY } from './validation-package.ts';
import type { GoldenAmendment, GoldenPackage } from './validation-package.ts';
import { GOLDEN_VALIDATION_ID, goldenAt } from './validation-records.ts';

/** What a golden verification run leaves behind. */
export interface GoldenRun {
  readonly verification: VariantValidationVerification;
  readonly fs: MemoryPackageFileSystem;
  readonly original: PackageSnapshot;
}

/**
 * Stores the package and its amendments, reads them back and verifies with `selectedHead`.
 *
 * @example
 * const run = await verifyGolden(validationPackage(), [], null);
 * run.verification.effective_implementation_validation_status; // 'verified'
 */
export async function verifyGolden(
  fixture: GoldenPackage,
  amendments: readonly GoldenAmendment[],
  selectedHead: Sha256Hex | null,
): Promise<GoldenRun> {
  const fs = new MemoryPackageFileSystem();
  const packageDirectory = PACKAGE_LAYOUT.executionDirectory(GOLDEN_IDENTITY);
  for (const file of fixture.files) {
    unwrap(await fs.writeOnce(`${packageDirectory}/${file.path}`, file.bytes));
  }
  const amendmentsDirectory = PACKAGE_LAYOUT.amendmentsDirectory(GOLDEN_IDENTITY);
  for (const amendment of amendments) {
    for (const file of amendment.snapshot.files) {
      unwrap(await fs.writeOnce(`${amendmentsDirectory}/${amendment.snapshot.directory}/${file.path}`, file.bytes));
    }
  }
  const original = unwrap(await readPackageSnapshot(fs, GOLDEN_IDENTITY));
  const verified = verifyVariantValidation(
    {
      variant_validation_id: GOLDEN_VALIDATION_ID,
      original,
      amendments: unwrap(await readAmendmentSnapshots(fs, GOLDEN_IDENTITY)),
      selected_head: selectedHead,
      referenced_package_indexes: [],
      checked_at: goldenAt(30_000),
    },
    FIXTURE_DEPS,
  );
  const verification = unwrap(verified);
  const checked = FIXTURE_DEPS.validator.validateAs(
    'variant_validation_verification',
    JSON.parse(JSON.stringify(verification)) as Parameters<typeof FIXTURE_DEPS.validator.validateAs>[1],
  );
  assert.equal(checked.valid, true, 'the verification is a valid CTR-RUA-004 record');
  return { verification, fs, original };
}

/**
 * The codes of a verification's effective status reasons, sorted, for exact comparison.
 *
 * @example
 * reasonCodesOf(run.verification); // ['MANIFEST_DRIFT']
 */
export function reasonCodesOf(verification: VariantValidationVerification): readonly string[] {
  return verification.effective_status_reasons.map((reason) => reason.code).toSorted();
}

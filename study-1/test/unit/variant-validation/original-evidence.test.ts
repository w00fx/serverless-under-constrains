// What the verifier reads from the original bytes of a validation package, once: the scientific
// assessment, the stored oracle results it was read from (each once), and this validation's own
// safety and late-evidence assessments (BR-RUA-038, BR-RUA-043, BR-RUA-046).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { readOriginalEvidence } from '../../../src/variant-validation/original-evidence.ts';
import type { OriginalEvidence } from '../../../src/variant-validation/original-evidence.ts';
import { runExecutionManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { digest } from '../../support/record-contract/record-builders.ts';
import { recordFile, replaceFile, withoutFile } from '../../golden/variant-validation/support/golden-files.ts';
import { validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { GOLDEN_VALIDATION_ID } from '../../golden/variant-validation/support/validation-records.ts';
import { recordAt } from './support/package-edits.ts';

const SOUND = validationPackage();

function originalOf(files: readonly PackageFile[], summary = SOUND.summary): OriginalEvidence {
  return readOriginalEvidence({ files, variant_validation_id: GOLDEN_VALIDATION_ID, summary }, FIXTURE_DEPS);
}

describe('readOriginalEvidence', () => {
  it('reads a sound package: valid science, both stored results, and its own assessments', () => {
    const original = originalOf(SOUND.files);
    assert.equal(original.scientific.validation_validity, 'valid');
    assert.deepEqual(original.scientific.reasons, []);
    assert.deepEqual(
      original.result_refs,
      SOUND.summary.trial_results.flatMap((entry) => ('oracle_result_ref' in entry ? [entry.oracle_result_ref] : [])),
    );
    assert.deepEqual(original.safety, { ok: true, value: recordAt(SOUND.files, EXECUTION_PATHS.safetyAssessment) });
    assert.deepEqual(original.late_evidence, {
      ok: true,
      value: recordAt(SOUND.files, EXECUTION_PATHS.lateEvidenceAssessment),
    });
  });

  it('cites no result of a trial whose stored result cannot be read', () => {
    const [control] = SOUND.summary.trial_results;
    assert.ok('oracle_result_ref' in control);
    const treatmentResult = SOUND.summary.trial_results[1];
    assert.ok('oracle_result_ref' in treatmentResult);
    const original = originalOf(withoutFile(SOUND.files, treatmentResult.oracle_result_ref.artifact_path));
    assert.deepEqual(original.result_refs, [control.oracle_result_ref]);
    assert.equal(original.scientific.validation_validity, 'indeterminate');
  });

  it("holds the assessments to the summary's manifest when admission cannot be read", () => {
    const run = replaceFile(
      SOUND.files,
      EXECUTION_PATHS.executionManifest,
      recordFile('x', runExecutionManifest()).bytes,
    );
    const original = originalOf(run);
    assert.equal(original.scientific.validation_validity, 'invalid');
    assert.deepEqual(
      original.scientific.reasons.map((reason) => reason.code),
      ['ADMISSION_INVALID'],
    );
    assert.equal(original.scientific.control_verdict, undefined);
    assert.equal(original.scientific.treatment_verdict, undefined);
    assert.deepEqual(original.result_refs, []);
    assert.ok(original.safety.ok && original.late_evidence.ok);

    const elsewhere = originalOf(run, { ...SOUND.summary, execution_manifest_sha256: digest('another manifest') });
    assert.ok(!elsewhere.safety.ok && !elsewhere.late_evidence.ok);
    assert.match(elsewhere.safety.error, /expected validation .* under manifest /);
  });
});

// Step A10 (BR-RUA-026, BR-RUA-028): a probe selects nothing; a run or a validation consumes
// exactly the usable probe it selected, with an indexed transport-scope snapshot to compare.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QualificationSelection } from '../../../src/admission/admission-ports.ts';
import { assessQualification } from '../../../src/admission/qualification-check.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { ProbePackageInput } from '../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';

const validator = createRecordValidator();
const OTHER_SHA = 'cd'.repeat(32) as Sha256Hex;

async function selectedInput(): Promise<{ selection: QualificationSelection; input: ProbePackageInput }> {
  const harness = await AdmissionHarness.create('RUN');
  const read = await harness.packages.readProbePackage(harness.selection());
  assert.ok(read.ok);
  return { selection: harness.selection(), input: read.value };
}

function codesOf(verdict: ReturnType<typeof assessQualification>): readonly string[] {
  return verdict.passed ? [] : verdict.reasons.map((reason) => reason.code);
}

describe('assessQualification (A10)', () => {
  it('passes a probe that selects nothing, and refuses one that selects a probe', async () => {
    const probe = assessQualification('TRANSPORT_PROBE', undefined, undefined, validator);
    assert.ok(probe.passed);
    assert.equal(probe.value, null);
    assert.equal(probe.statement.expected, 'no_selected_probe');
    const { selection } = await selectedInput();
    const selecting = assessQualification('TRANSPORT_PROBE', selection, undefined, validator);
    assert.ok(!selecting.passed);
    assert.equal(selecting.rejection_class, 'QUALIFICATION');
    assert.deepEqual(codesOf(selecting), ['QUALIFICATION_NOT_ALLOWED']);
    assert.deepEqual(selecting.statement.observed, {
      transport_probe_id: selection.transport_probe_id,
      original_package_index_sha256: selection.original_package_index_sha256,
      amendment_head_sha256: 'none',
    });
  });

  it('refuses a run or a validation without a selection or a reading', async () => {
    const { selection } = await selectedInput();
    const none = assessQualification('RUN', undefined, undefined, validator);
    assert.ok(!none.passed);
    assert.deepEqual(none.reasons, [
      {
        code: 'QUALIFICATION_NOT_SELECTED',
        subject: 'BR-RUA-028',
        detail: 'a RUN selects no probe; expected an explicit --probe',
      },
    ]);
    assert.deepEqual(codesOf(assessQualification('VARIANT_VALIDATION', selection, undefined, validator)), [
      'QUALIFICATION_NOT_SELECTED',
    ]);
  });

  it('refuses an unreadable probe package', async () => {
    const { selection } = await selectedInput();
    const verdict = assessQualification('RUN', selection, err({ code: 'NOT_FOUND', detail: 'no package' }), validator);
    assert.deepEqual(codesOf(verdict), ['PROBE_PACKAGE_UNREADABLE']);
  });

  it('passes the usable selected probe with its stored snapshot', async () => {
    const { selection, input } = await selectedInput();
    const verdict = assessQualification('RUN', selection, ok(input), validator);
    assert.ok(verdict.passed);
    assert.ok(verdict.value !== null);
    assert.equal(verdict.value.selection, selection);
    assert.equal(verdict.value.snapshot.record_type, 'transport_scope_snapshot');
    assert.equal(verdict.value.snapshot_sha256, verdict.value.usability.transport_scope_snapshot_sha256);
  });

  it('refuses a selection the verified package does not match', async () => {
    const { selection, input } = await selectedInput();
    const wrongIndex = { ...selection, original_package_index_sha256: OTHER_SHA };
    const verdict = assessQualification('RUN', wrongIndex, ok(input), validator);
    assert.ok(!verdict.passed);
    assert.deepEqual(verdict.reasons[0], {
      code: 'SELECTION_MISMATCH',
      subject: 'BR-RUA-028',
      detail: `the verified original_package_index_sha256 is ${selection.original_package_index_sha256}; expected the selected ${OTHER_SHA}`,
    });
    const wrongProbe = {
      ...selection,
      transport_probe_id: '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    } as QualificationSelection;
    assert.ok(codesOf(assessQualification('RUN', wrongProbe, ok(input), validator)).includes('SELECTION_MISMATCH'));
    const withHead = { ...selection, amendment_head_sha256: OTHER_SHA };
    const headed = assessQualification('RUN', withHead, ok({ ...input, selected_head: OTHER_SHA }), validator);
    assert.ok(!headed.passed);
    assert.deepEqual(
      (headed.statement.observed as Readonly<Record<string, string>>)['amendment_head_sha256'],
      OTHER_SHA,
    );
  });

  it('refuses a selected probe without its transport-scope snapshot', async () => {
    const { selection, input } = await selectedInput();
    const original = {
      ...input.original,
      files: input.original.files.filter((file) => file.path !== EXECUTION_PATHS.transportScopeSnapshot),
    };
    const verdict = assessQualification('RUN', selection, ok({ ...input, original }), validator);
    assert.ok(!verdict.passed);
    assert.equal(verdict.reasons[0].code, 'SELECTED_SCOPE_SNAPSHOT_MISSING');
  });
});

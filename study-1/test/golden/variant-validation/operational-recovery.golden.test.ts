// AC-RUA-026 golden (BR-RUA-038, BR-RUA-044): scientifically valid frozen validation evidence with
// incomplete cleanup, audit or lease closure, and a valid amendment chain that repairs only that
// closure. The verifier derives effective cleanup `succeeded`, audit `clean` and lease `released`
// and an effective status `verified` or `failed`, while the original summary and the scientific
// results stay byte for byte what was frozen.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OperationalClosure } from '../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import { readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import { unwrap } from '../../support/evidence-package/probe-package-fixtures.ts';
import { CLEAN_CLOSURE, GOLDEN_IDENTITY, recoveryAmendment, validationPackage } from './support/validation-package.ts';
import { verifyGolden } from './support/golden-verification.ts';

interface RecoveryCase {
  readonly case_id: string;
  readonly closure: OperationalClosure;
  readonly terminal_reason: string;
  readonly control: 'pass' | 'fail';
  readonly effective: 'verified' | 'failed';
}

const CASES: readonly RecoveryCase[] = [
  {
    case_id: 'cleanup-repaired',
    closure: { ...CLEAN_CLOSURE, cleanup_status: 'partial' },
    terminal_reason: 'CLEANUP_INCOMPLETE',
    control: 'pass',
    effective: 'verified',
  },
  {
    case_id: 'audit-repaired',
    closure: { ...CLEAN_CLOSURE, leak_audit_status: 'inconclusive' },
    terminal_reason: 'LEAK_AUDIT_NOT_CLEAN',
    control: 'pass',
    effective: 'verified',
  },
  {
    case_id: 'lease-repaired',
    closure: { ...CLEAN_CLOSURE, lease_status: 'recovery_required' },
    terminal_reason: 'LEASE_RELEASE_FAILED',
    control: 'fail',
    effective: 'failed',
  },
];

describe('AC-RUA-026 operational recovery of a variant validation', () => {
  for (const scenario of CASES) {
    it(scenario.case_id, async () => {
      const fixture = validationPackage({ control: scenario.control, closure: scenario.closure });
      assert.equal(fixture.summary.implementation_validation_status, 'indeterminate');
      assert.equal(fixture.summary.validation_validity, 'valid');
      assert.equal(fixture.summary.validation_terminal_reason, scenario.terminal_reason);
      const recovery = recoveryAmendment(fixture, CLEAN_CLOSURE);

      const run = await verifyGolden(fixture, [recovery], recovery.index_sha256);
      const { verification } = run;
      assert.equal(verification.package_eligibility, 'eligible');
      assert.equal(verification.selected_amendment_head_sha256, recovery.index_sha256);
      assert.equal(verification.declared_implementation_validation_status, 'indeterminate');
      assert.equal(verification.effective_implementation_validation_status, scenario.effective);
      assert.equal(verification.validation_validity, 'valid');
      assert.equal(verification.effective_cleanup_status, 'succeeded');
      assert.equal(verification.effective_leak_audit_status, 'clean');
      assert.equal(verification.effective_lease_status, 'released');
      assert.equal(verification.operational_recovery_applied, true);
      assert.ok(
        verification.evidence_refs.some((ref) => ref.package_index_sha256 === recovery.index_sha256),
        'the verification cites the recovery amendment it applied',
      );

      // The original package, its summary and its oracle results are unchanged after verification.
      const reread = unwrap(await readPackageSnapshot(run.fs, GOLDEN_IDENTITY));
      assert.deepEqual(
        reread.files.map((file) => [file.path, Buffer.from(file.bytes).toString('hex')]),
        fixture.files
          .map((file) => [file.path, Buffer.from(file.bytes).toString('hex')])
          .toSorted(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : 1)),
      );
      assert.equal(verification.validation_summary_ref.artifact_path, 'summary/validation-summary.json');
      assert.equal(verification.validation_summary_ref.package_index_sha256, fixture.index_sha256);
    });
  }
});

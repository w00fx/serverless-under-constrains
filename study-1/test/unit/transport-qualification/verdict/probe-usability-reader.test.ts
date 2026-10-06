// Reading BR-RUA-026's facts from a stored probe package and its selected amendment chain
// (design §8.11, §8.16; AC-RUA-056): the frozen result only by the digest the summary names, the
// effective late evidence, closure and safety after the selected chain, and the indexed snapshot.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { UtcMillis, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { OperationalClosure } from '../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { TransportProbeSummary } from '../../../../src/record-contract/records/group-c/transport_probe_summary.ts';
import { readProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import type { ProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import {
  frozenProbeResult,
  GOLDEN_VALIDATOR,
} from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import {
  amendmentChain,
  packageInput,
  probePackage,
  recordFile,
} from '../../../golden/transport-qualification/verdict/support/probe-package.ts';
import type {
  AmendmentDirectory,
  BuiltProbePackage,
  ProbePackageVariation,
} from '../../../golden/transport-qualification/verdict/support/probe-package.ts';
import { probeFiles } from '../../treatment-fidelity/support/treatment-evidence.ts';
import { present } from '../../treatment-fidelity/support/view-edits.ts';
import { billingPayload, lateEvidencePayload, recoveryPayload } from './support/probe-amendment-payloads.ts';

const DEPS = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
const RESULT_PATH = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');
const PARTIAL: OperationalClosure = {
  cleanup_status: 'partial',
  leak_audit_status: 'leaks_detected',
  lease_status: 'recovery_required',
};
const CLEAN: OperationalClosure = { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' };

function built(variation: ProbePackageVariation = {}): BuiltProbePackage {
  return probePackage(probeFiles(), variation);
}

function read(pkg: BuiltProbePackage, chain: readonly AmendmentDirectory[] = []): ProbeUsabilityInput {
  return readProbeUsabilityInput(packageInput(pkg, chain, chain.at(-1)?.index_sha256 ?? null), DEPS);
}

function replaced(pkg: BuiltProbePackage, ...files: readonly PackageFile[]): BuiltProbePackage {
  const paths = new Set(files.map((file) => file.path));
  return { ...pkg, files: [...pkg.files.filter((file) => !paths.has(file.path)), ...files] };
}

function summaryOf(pkg: BuiltProbePackage): TransportProbeSummary {
  const bytes =
    pkg.files.find((file) => file.path === EXECUTION_PATHS.transportProbeSummary)?.bytes ?? new Uint8Array();
  return JSON.parse(new TextDecoder().decode(bytes)) as TransportProbeSummary;
}

describe('readProbeUsabilityInput', () => {
  it('reads every fact of an eligible, clean package', () => {
    const pkg = built();
    const facts = read(pkg);
    assert.equal(facts.transport_probe_id, '2559d5f6-ec95-4777-a74e-452fcfde7526');
    assert.equal(facts.original_package_index_sha256, pkg.index_sha256);
    assert.equal(facts.selected_amendment_head_sha256, null);
    assert.deepEqual(facts.probe, {
      transport_probe_verdict: 'pass',
      probe_validity: 'valid',
      treatment_fidelity: 'verified',
      evidence_integrity: 'verified',
    });
    assert.equal(facts.late_evidence_status, 'none');
    assert.deepEqual(facts.closure, {
      effective_cleanup_status: 'succeeded',
      effective_leak_audit_status: 'clean',
      effective_lease_status: 'released',
    });
    assert.equal(facts.safety_status, 'within_limits');
    assert.equal(facts.package_eligibility, 'eligible');
    assert.notEqual(facts.transport_scope_snapshot_sha256, undefined);
    assert.equal(facts.assessed_at, '2026-10-05T12:40:00.000Z');
    assert.deepEqual(
      facts.evidence_refs.map((ref) => [ref.artifact_path, ref.package_index_sha256]),
      [
        [EXECUTION_PATHS.transportProbeSummary, pkg.index_sha256],
        [RESULT_PATH, pkg.index_sha256],
        [EXECUTION_PATHS.transportScopeSnapshot, pkg.index_sha256],
      ],
    );
  });

  it('makes safety breached through a selected breached billing import', () => {
    const pkg = built();
    assert.equal(
      read(pkg, amendmentChain(pkg, [{ kind: 'BILLING', payload: [billingPayload(pkg, 'breached')] }])).safety_status,
      'breached',
    );
  });

  it("keeps the summary's safety through a billing import within the limit", () => {
    const pkg = built();
    const chain = amendmentChain(pkg, [{ kind: 'BILLING', payload: [billingPayload(pkg, 'within_limit')] }]);
    assert.equal(read(pkg, chain).safety_status, 'within_limits');
  });

  it('reads the effective late evidence from the last selected late-evidence amendment', () => {
    const pkg = built();
    const chain = amendmentChain(pkg, [
      { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(pkg, 'contradictory')] },
      { kind: 'REASSESSMENT', payload: [lateEvidencePayload(pkg, 'consistent')] },
    ]);
    assert.equal(read(pkg, chain).late_evidence_status, 'consistent');
    assert.equal(read(pkg, chain.slice(0, 1)).late_evidence_status, 'contradictory');
  });

  it('reads an unreadable selected late-evidence assessment as unverified', () => {
    const pkg = built();
    const unreadable = {
      path: 'payload/late-evidence-assessment.json',
      bytes: new TextEncoder().encode('{"late_evidence_status":'),
    };
    const chain = amendmentChain(pkg, [{ kind: 'LATE_EVIDENCE', payload: [unreadable] }]);
    assert.equal(read(pkg, chain).late_evidence_status, 'unverified');
  });

  it('applies a selected operational recovery to the closure', () => {
    const pkg = built({
      summary: {
        cleanup_status: 'partial',
        leak_audit_status: 'leaks_detected',
        lease_status: 'recovery_required',
        probe_terminal_reason: 'CLEANUP_INCOMPLETE',
      },
    });
    assert.equal(read(pkg).closure.effective_cleanup_status, 'partial');
    const chain = amendmentChain(pkg, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(pkg, PARTIAL, CLEAN)] },
    ]);
    assert.deepEqual(read(pkg, chain).closure, {
      effective_cleanup_status: 'succeeded',
      effective_leak_audit_status: 'clean',
      effective_lease_status: 'released',
    });
  });

  it('knows nothing of the probe without its summary', () => {
    const pkg = built();
    const facts = read({
      ...pkg,
      files: pkg.files.filter((file) => file.path !== EXECUTION_PATHS.transportProbeSummary),
    });
    assert.equal(facts.package_eligibility, 'ineligible');
    assert.equal(facts.probe.transport_probe_verdict, 'indeterminate');
    assert.equal(facts.probe.treatment_fidelity, 'unverified');
    assert.equal(facts.late_evidence_status, 'unverified');
    assert.equal(facts.safety_status, 'unverified');
    assert.deepEqual(facts.closure, {
      effective_cleanup_status: 'unverified',
      effective_leak_audit_status: 'unverified',
      effective_lease_status: 'unverified',
    });
    assert.ok(facts.evidence_refs.every((ref) => ref.artifact_path !== EXECUTION_PATHS.transportProbeSummary));
  });

  it('ignores a result whose bytes are not the ones the summary names', () => {
    const pkg = built();
    const other = { ...frozenProbeResult(probeFiles()), checked_at: '2026-10-05T12:09:00.000Z' as UtcMillis };
    const facts = read(replaced(pkg, recordFile(RESULT_PATH, other)));
    assert.equal(facts.probe.transport_probe_verdict, 'indeterminate');
    assert.equal(facts.probe.evidence_integrity, 'unverified');
  });

  it('ignores a frozen result of another probe', () => {
    const pkg = built();
    const other = {
      ...frozenProbeResult(probeFiles()),
      transport_probe_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' as Uuid4,
    };
    const result = recordFile(RESULT_PATH, other);
    const renamed: TransportProbeSummary = {
      ...summaryOf(pkg),
      probe_result_sha256: sha256Hex(result.bytes),
    };
    const summary = recordFile(EXECUTION_PATHS.transportProbeSummary, renamed);
    const facts = read(replaced(pkg, result, summary));
    assert.equal(facts.probe.probe_validity, 'indeterminate');
  });

  it('ignores a scope snapshot the package index does not list', () => {
    const withSnapshot = built();
    const snapshot = present(
      withSnapshot.files.find((file) => file.path === EXECUTION_PATHS.transportScopeSnapshot),
      'scope snapshot',
    );
    const pkg = built({ without_scope_snapshot: true });
    assert.equal(read(pkg).transport_scope_snapshot_sha256, undefined);
    const unindexed = { ...pkg, files: [...pkg.files, snapshot] };
    assert.equal(read(unindexed).transport_scope_snapshot_sha256, undefined);
  });

  it('ignores the scope snapshot when the package index is unreadable', () => {
    const pkg = built();
    const facts = read(
      replaced(pkg, { path: EXECUTION_PATHS.packageIndex, bytes: new TextEncoder().encode('not json') }),
    );
    assert.equal(facts.transport_scope_snapshot_sha256, undefined);
    assert.equal(facts.package_eligibility, 'ineligible');
  });
});

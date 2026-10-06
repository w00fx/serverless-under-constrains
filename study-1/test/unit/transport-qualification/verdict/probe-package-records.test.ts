// Reading probe records back from exact stored bytes (BR-RUA-033): absent, unparseable or
// schema-invalid files read as nothing; an amendment is found only by its index digest.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import {
  readAmendmentRecord,
  readProbeRecord,
} from '../../../../src/transport-qualification/verdict/probe-package-records.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { amendmentChain, probePackage } from '../../../golden/transport-qualification/verdict/support/probe-package.ts';
import { probeFiles } from '../../treatment-fidelity/support/treatment-evidence.ts';
import { present } from '../../treatment-fidelity/support/view-edits.ts';
import { billingPayload, lateEvidencePayload, recoveryPayload } from './support/probe-amendment-payloads.ts';

const DEPS = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
const SUMMARY = EXECUTION_PATHS.transportProbeSummary;

function text(path: string, content: string): { readonly path: string; readonly bytes: Uint8Array } {
  return { path, bytes: new TextEncoder().encode(content) };
}

describe('readProbeRecord', () => {
  it('reads a valid record with the digest of its exact bytes', () => {
    const pkg = probePackage(probeFiles());
    const stored = present(readProbeRecord(pkg.files, SUMMARY, 'transport_probe_summary', DEPS), 'summary');
    const bytes = pkg.files.find((file) => file.path === SUMMARY)?.bytes ?? new Uint8Array();
    assert.equal(stored.record.record_type, 'transport_probe_summary');
    assert.equal(stored.sha256, sha256Hex(bytes));
  });

  it('reads an absent, unparseable or schema-invalid file as nothing', () => {
    assert.equal(readProbeRecord([], SUMMARY, 'transport_probe_summary', DEPS), undefined);
    assert.equal(
      readProbeRecord([text(SUMMARY, '{"record_type":')], SUMMARY, 'transport_probe_summary', DEPS),
      undefined,
    );
    assert.equal(
      readProbeRecord(
        [text(SUMMARY, '{"record_type":"transport_probe_summary"}')],
        SUMMARY,
        'transport_probe_summary',
        DEPS,
      ),
      undefined,
    );
  });

  it('never reads a record of another type at the path', () => {
    const pkg = probePackage(probeFiles());
    assert.equal(readProbeRecord(pkg.files, SUMMARY, 'transport_probe_result', DEPS), undefined);
  });
});

describe('readAmendmentRecord', () => {
  it('reads the payload of the amendment whose index has the digest', () => {
    const pkg = probePackage(probeFiles());
    const chain = amendmentChain(pkg, [
      { kind: 'BILLING', payload: [billingPayload(pkg, 'breached')] },
      { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(pkg, 'consistent')] },
    ]);
    const snapshots = chain.map((amendment) => amendment.snapshot);
    const billing = present(chain[0], 'billing amendment');
    const late = present(chain[1], 'late-evidence amendment');
    assert.equal(
      readAmendmentRecord(billing.index_sha256, snapshots, AMENDMENT_PATHS.billingImport, 'billing_import', DEPS)
        ?.billed_cost_check,
      'breached',
    );
    assert.equal(
      readAmendmentRecord(
        late.index_sha256,
        snapshots,
        AMENDMENT_PATHS.lateEvidenceAssessment,
        'late_evidence_assessment',
        DEPS,
      )?.late_evidence_status,
      'consistent',
    );
    assert.equal(
      readAmendmentRecord(late.index_sha256, snapshots, AMENDMENT_PATHS.billingImport, 'billing_import', DEPS),
      undefined,
    );
  });

  it('finds no amendment for an unknown digest or a snapshot without an index', () => {
    const pkg = probePackage(probeFiles());
    const chain = amendmentChain(pkg, [{ kind: 'BILLING', payload: [billingPayload(pkg, 'within_limit')] }]);
    const unknown = 'f'.repeat(64) as Sha256Hex;
    const snapshots = chain.map((amendment) => amendment.snapshot);
    assert.equal(
      readAmendmentRecord(unknown, snapshots, AMENDMENT_PATHS.billingImport, 'billing_import', DEPS),
      undefined,
    );
    const amendment = present(chain[0], 'billing amendment');
    const indexless = {
      ...amendment.snapshot,
      files: amendment.snapshot.files.filter((file) => file.path !== AMENDMENT_PATHS.amendmentIndex),
    };
    assert.equal(
      readAmendmentRecord(amendment.index_sha256, [indexless], AMENDMENT_PATHS.billingImport, 'billing_import', DEPS),
      undefined,
    );
  });

  it('reads the recovery payload the support builds as a valid record', () => {
    const pkg = probePackage(probeFiles());
    const closure = { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' } as const;
    const recovery = recoveryPayload(pkg, closure, closure);
    const stored = readProbeRecord([recovery], recovery.path, 'transport_probe_summary', DEPS);
    assert.equal(stored, undefined, 'a recovery record is not a summary');
    const parsed = JSON.parse(new TextDecoder().decode(recovery.bytes)) as Parameters<
      typeof GOLDEN_VALIDATOR.validateAs
    >[1];
    assert.equal(GOLDEN_VALIDATOR.validateAs('operational_recovery_record', parsed).valid, true);
  });
});

// Schema-valid amendment payloads over a stored probe package (design §8.16, §8.17): a billing
// import, a late-evidence assessment and an operational recovery record, each naming the package's
// manifest and original index digests. The usability reader reads them back from the selected
// chain, so they must be the records a real amendment would carry.

import { AMENDMENT_PATHS, PACKAGE_LAYOUT } from '../../../../../src/evidence-package/package-layout.ts';
import type { PackageFile } from '../../../../../src/evidence-package/package-file-system.ts';
import { sha256Hex } from '../../../../../src/record-contract/digests.ts';
import type { MoneyDecimal, Sha256Hex, UtcMillis, Uuid4 } from '../../../../../src/record-contract/primitives.ts';
import type { BillingImport } from '../../../../../src/record-contract/records/group-c/billing_import.ts';
import type { LateEvidenceAssessment } from '../../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type {
  OperationalClosure,
  OperationalRecoveryRecord,
} from '../../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import {
  PROBE_IDENTITY,
  recordFile,
} from '../../../../golden/transport-qualification/verdict/support/probe-package.ts';
import type { BuiltProbePackage } from '../../../../golden/transport-qualification/verdict/support/probe-package.ts';

const PROBE_RESULT_PATH = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');

/**
 * A billing import of the probe whose check is `within_limit` or `breached`.
 *
 * @example
 * billingPayload(built, 'breached').path; // 'payload/billing-import.json'
 */
export function billingPayload(built: BuiltProbePackage, check: 'within_limit' | 'breached'): PackageFile {
  const total = (check === 'breached' ? '7.50' : '0.0042') as MoneyDecimal;
  const record: BillingImport = {
    schema_version: 1,
    record_type: 'billing_import',
    transport_probe_id: PROBE_IDENTITY.transport_probe_id,
    execution_manifest_sha256: built.manifest_sha256,
    original_package_index_sha256: built.index_sha256,
    billing_export: {
      export_sha256: sha256Hex(new TextEncoder().encode('probe billing export')),
      period_start: '2026-10-05T00:00:00.000Z' as UtcMillis,
      period_end: '2026-10-06T00:00:00.000Z' as UtcMillis,
      period_final: true,
    },
    attribution_window_start: '2026-10-05T12:00:00.000Z' as UtcMillis,
    attribution_window_end: '2026-10-05T13:00:00.000Z' as UtcMillis,
    lines_used: [
      {
        line_id: 'line-0001',
        product_code: 'AWSLambda',
        operation: 'Invoke',
        resource_id: 'arn:aws:lambda:us-east-1:000000000000:function:rua-provider',
        usage_start: '2026-10-05T12:05:00.000Z' as UtcMillis,
        usage_end: '2026-10-05T12:06:00.000Z' as UtcMillis,
        currency: 'USD',
        cost: total,
      },
    ],
    exclusions: [],
    ceiling_usd: '5.00' as MoneyDecimal,
    billed_cost_check: check,
    attributed_total_usd: total,
    reasons: [],
    imported_at: '2026-10-07T00:00:00.000Z' as UtcMillis,
  };
  return recordFile(AMENDMENT_PATHS.billingImport, record);
}

/**
 * A late-evidence assessment of the probe reassessing its frozen result.
 *
 * @example
 * lateEvidencePayload(built, 'consistent');
 */
export function lateEvidencePayload(built: BuiltProbePackage, status: 'consistent' | 'contradictory'): PackageFile {
  const result = built.files.find((file) => file.path === PROBE_RESULT_PATH)?.bytes ?? new Uint8Array();
  const frozen = { artifact_path: PROBE_RESULT_PATH, artifact_sha256: sha256Hex(result) };
  const changes =
    status === 'contradictory' ? [{ field: '/transport_probe_verdict', frozen: 'pass', reassessed: 'fail' }] : [];
  const record: LateEvidenceAssessment = {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    transport_probe_id: PROBE_IDENTITY.transport_probe_id,
    execution_manifest_sha256: built.manifest_sha256,
    monitoring: 'complete',
    late_evidence_status: status,
    monitoring_started_at: '2026-10-05T12:09:00.000Z' as UtcMillis,
    monitoring_ended_at: '2026-10-05T12:19:00.000Z' as UtcMillis,
    correlated_record_count: 1,
    reassessments: [{ frozen_result_ref: frozen, status, changes }],
    reasons: [],
    evidence_refs: [],
    assessed_at: '2026-10-05T13:30:00.000Z' as UtcMillis,
  };
  return recordFile(AMENDMENT_PATHS.lateEvidenceAssessment, record);
}

/**
 * An operational recovery of the probe from `original` to `recovered`.
 *
 * @example
 * recoveryPayload(built, PARTIAL, CLEAN);
 */
export function recoveryPayload(
  built: BuiltProbePackage,
  original: OperationalClosure,
  recovered: OperationalClosure,
): PackageFile {
  const record: OperationalRecoveryRecord = {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    transport_probe_id: PROBE_IDENTITY.transport_probe_id,
    execution_manifest_sha256: built.manifest_sha256,
    recovery_id: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d' as Uuid4,
    original_package_index_sha256: built.index_sha256,
    original_closure: original,
    recovered_closure: recovered,
    steps_run: [3, 4, 11],
    cleanup_result_ref: { artifact_path: AMENDMENT_PATHS.cleanupResult, artifact_sha256: digestOf('cleanup') },
    leak_audit_result_ref: { artifact_path: AMENDMENT_PATHS.leakAuditResult, artifact_sha256: digestOf('audit') },
    reasons: [],
    started_at: '2026-10-05T14:00:00.000Z' as UtcMillis,
    completed_at: '2026-10-05T14:05:00.000Z' as UtcMillis,
  };
  return recordFile(AMENDMENT_PATHS.operationalRecoveryRecord, record);
}

function digestOf(text: string): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(text));
}

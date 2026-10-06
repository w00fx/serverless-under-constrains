// Amendment chains over a golden validation package, built with the production `buildAmendment`:
// OPERATIONAL_RECOVERY amendments that repair the closure, and BILLING amendments that carry a
// billing import. Each chain is linear and digest-valid by construction.

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';
import type { BillingImport } from '../../../../src/record-contract/records/group-c/billing_import.ts';
import type { OperationalClosure } from '../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { ValidationSummary } from '../../../../src/record-contract/records/group-c/validation_summary.ts';
import type { AmendmentKind } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { AmendmentSnapshot } from '../../../../src/evidence-package/amendment-snapshots.ts';
import { buildAmendment } from '../../../../src/evidence-package/amendments.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { withinLimitBilling } from '../../../contract/record-contract/group-c/examples/package-examples.ts';
import { FIXTURE_VALIDATOR, unwrap } from '../../../support/evidence-package/probe-package-fixtures.ts';
import { uuid } from '../../../support/record-contract/record-builders.ts';
import { placeholder, recordFile, refTo, toJsonValue } from './golden-files.ts';
import { GOLDEN_IDENTITY } from './validation-package.ts';
import type { GoldenPackage } from './validation-package.ts';
import { GOLDEN_VALIDATION_ID, goldenAt, validated } from './validation-records.ts';

/** One amendment of a golden chain, and the digest of its index. */
export interface GoldenAmendment {
  readonly snapshot: AmendmentSnapshot;
  readonly index_sha256: Sha256Hex;
}

/** What each amendment of a chain carries. */
export interface GoldenAmendmentSpec {
  readonly kind: AmendmentKind;
  readonly payload: readonly PackageFile[];
}

/**
 * A linear, dense, digest-valid chain over the package, in `specs` order.
 *
 * @example
 * const [recovery] = amendmentChain(fixture, [{ kind: 'OPERATIONAL_RECOVERY', payload: recoveryPayload(fixture, CLEAN_CLOSURE) }]);
 */
export function amendmentChain(
  fixture: GoldenPackage,
  specs: readonly GoldenAmendmentSpec[],
): readonly GoldenAmendment[] {
  const chain: GoldenAmendment[] = [];
  for (const [position, spec] of specs.entries()) {
    const built = unwrap(
      buildAmendment({
        identity: GOLDEN_IDENTITY,
        execution_manifest_sha256: fixture.manifest_sha256,
        amendment_id: uuid(0x1711 + position),
        amendment_kind: spec.kind,
        sequence: position + 1,
        original_package_index_sha256: fixture.index_sha256,
        parent_amendment_index_sha256: chain.at(-1)?.index_sha256 ?? null,
        payload: spec.payload,
        created_at: goldenAt(21_000 + position),
      }),
    );
    chain.push({
      snapshot: {
        directory: built.directory.slice(built.directory.lastIndexOf('/') + 1),
        files: built.files,
        special_entries: [],
      },
      index_sha256: sha256Hex(serializeRecordFile(built.index)),
    });
  }
  return chain;
}

/**
 * A single OPERATIONAL_RECOVERY amendment that repairs the package's closure to `recovered`.
 *
 * @example
 * const recovery = recoveryAmendment(fixture, CLEAN_CLOSURE);
 */
export function recoveryAmendment(fixture: GoldenPackage, recovered: OperationalClosure): GoldenAmendment {
  const [recovery] = amendmentChain(fixture, [
    { kind: 'OPERATIONAL_RECOVERY', payload: recoveryPayload(fixture, recovered) },
  ]);
  if (recovery === undefined) {
    throw new Error('a one-amendment chain came back empty; expected one amendment');
  }
  return recovery;
}

/**
 * The payload of a recovery from the summary's closure to `recovered`.
 *
 * @example
 * recoveryPayload(fixture, CLEAN_CLOSURE);
 */
export function recoveryPayload(fixture: GoldenPackage, recovered: OperationalClosure): readonly PackageFile[] {
  const cleanupResult = placeholder(AMENDMENT_PATHS.cleanupResult);
  const auditResult = placeholder(AMENDMENT_PATHS.leakAuditResult);
  const record = {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: fixture.manifest_sha256,
    recovery_id: uuid(0x1710),
    original_package_index_sha256: fixture.index_sha256,
    original_closure: closureOf(fixture.summary),
    recovered_closure: recovered,
    steps_run: [3, 4, 11],
    cleanup_result_ref: refTo(cleanupResult),
    leak_audit_result_ref: refTo(auditResult),
    reasons: [],
    started_at: goldenAt(20_000),
    completed_at: goldenAt(20_500),
  } as const;
  validated(toJsonValue(record), 'operational_recovery_record', FIXTURE_VALIDATOR);
  return [cleanupResult, auditResult, recordFile(AMENDMENT_PATHS.operationalRecoveryRecord, record)];
}

/**
 * The payload of a BILLING amendment: a billing import of this validation with `check`, amending
 * `originalIndex` (by default the package's own index).
 *
 * @example
 * billingPayload(fixture, 'breached');
 */
export function billingPayload(
  fixture: GoldenPackage,
  check: BillingImport['billed_cost_check'],
  originalIndex: Sha256Hex = fixture.index_sha256,
): readonly PackageFile[] {
  // The example's run identity and outcome are replaced by this validation's.
  const replaced = new Set(['run_id', 'billed_cost_check', 'attributed_total_usd', 'reasons']);
  const base = Object.fromEntries(Object.entries(withinLimitBilling()).filter(([key]) => !replaced.has(key)));
  const outcome =
    check === 'unverified'
      ? {
          billed_cost_check: check,
          reasons: [
            {
              code: 'INCOMPLETE_PERIOD',
              subject: 'billing export',
              detail: 'the period is not final; expected a final period',
            },
          ],
        }
      : { billed_cost_check: check, attributed_total_usd: check === 'breached' ? '7.50' : '0.0042', reasons: [] };
  const record = {
    ...base,
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: fixture.manifest_sha256,
    original_package_index_sha256: originalIndex,
    ...outcome,
  };
  validated(toJsonValue(record), 'billing_import', FIXTURE_VALIDATOR);
  return [recordFile(AMENDMENT_PATHS.billingImport, record)];
}

/**
 * The closure a summary froze.
 *
 * @example
 * closureOf(fixture.summary).cleanup_status; // 'partial'
 */
export function closureOf(summary: ValidationSummary): OperationalClosure {
  if (summary.cleanup_status === 'not_started' || summary.cleanup_status === 'running') {
    throw new Error(`golden summary cleanup_status ${summary.cleanup_status}; expected a terminal status`);
  }
  return {
    cleanup_status: summary.cleanup_status,
    leak_audit_status: summary.leak_audit_status,
    lease_status: summary.lease_status,
  };
}

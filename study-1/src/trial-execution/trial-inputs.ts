// Phase T1 "freeze trial manifest" (design §10.2, §7; BR-RUA-019, BR-RUA-040): the trial's
// payment and approved decision are written first, then the trial manifest that pins their
// digests, the resource manifest digest and the parent execution manifest digest. Every file is
// written once with its canonical bytes, and the manifest digest is the SHA-256 of exactly the
// bytes written, so every later trial-scoped record names the file on disk (BR-RUA-033).

import { executionIdentityFields } from '../record-contract/envelope.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { UNIT_PATHS } from '../evidence-package/package-layout.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import type { TrialPlan } from './trial-execution-ports.ts';

/** The frozen manifest and the digest of its exact bytes. */
export interface FrozenTrialInputs {
  readonly manifest: TrialManifest;
  readonly manifest_sha256: Sha256Hex;
}

/** Where a trial's files go: the execution package directory and the file system. */
export interface TrialFileTarget {
  readonly files: PackageFileSystem;
  readonly package_directory: string;
}

/**
 * The package path of one file of a trial directory.
 *
 * @example
 * trialFilePath('runs/<run_id>', trialId, 'payment'); // 'runs/<run_id>/trials/<trial_id>/inputs/payment.json'
 */
export function trialFilePath(
  packageDirectory: string,
  trialId: TrialPlan['trial']['trial_id'],
  file: keyof typeof UNIT_PATHS,
): string {
  return `${packageDirectory}/${PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, file)}`;
}

/**
 * Writes one trial file once; the reason names the path when it was not written.
 *
 * @example
 * const failure = await writeTrialFile(target, trialId, 'oracleResult', bytes);
 */
export async function writeTrialFile(
  target: TrialFileTarget,
  trialId: TrialPlan['trial']['trial_id'],
  file: keyof typeof UNIT_PATHS,
  bytes: Uint8Array,
): Promise<StructuredReason | undefined> {
  const path = trialFilePath(target.package_directory, trialId, file);
  const written = await target.files.writeOnce(path, bytes);
  if (written.ok) {
    return undefined;
  }
  return {
    code: 'TRIAL_FILE_NOT_WRITTEN',
    subject: 'BR-RUA-043',
    artifact_path: path,
    detail: `${path} was not written (${written.error.code}: ${written.error.detail}); expected a new write-once file`,
  };
}

/**
 * Writes the trial inputs and the trial manifest (T1), or every reason they were not written.
 *
 * @example
 * const frozen = await freezeTrialInputs(target, plan, clock);
 * if (frozen.ok) frozen.value.manifest_sha256; // the digest every trial-scoped record names
 */
export async function freezeTrialInputs(
  target: TrialFileTarget,
  plan: TrialPlan,
  clock: WallClock,
): Promise<Result<FrozenTrialInputs, readonly StructuredReason[]>> {
  const paymentBytes = serializeRecordFile(plan.payment);
  const decisionBytes = serializeRecordFile(plan.approved_decision);
  const manifest: TrialManifest = {
    schema_version: 1,
    record_type: 'trial_manifest',
    ...executionIdentityFields(plan.execution),
    execution_manifest_sha256: plan.execution_manifest_sha256,
    resource_manifest_sha256: plan.resource_manifest_sha256,
    trial_id: plan.trial.trial_id,
    sequence: plan.trial.sequence,
    variant_id: plan.trial.variant_id,
    scenario: plan.trial.scenario,
    payment_sha256: sha256Hex(paymentBytes),
    approved_decision_sha256: sha256Hex(decisionBytes),
    frozen_at: formatUtcMillis(clock.now()),
  } as TrialManifest;
  const manifestBytes = serializeRecordFile(manifest);
  const trialId = plan.trial.trial_id;
  const failures: StructuredReason[] = [];
  for (const [file, bytes] of [
    ['payment', paymentBytes],
    ['approvedDecision', decisionBytes],
    ['trialManifest', manifestBytes],
  ] as const) {
    const failure = await writeTrialFile(target, trialId, file, bytes);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures.length === 0 ? ok({ manifest, manifest_sha256: sha256Hex(manifestBytes) }) : err(failures);
}

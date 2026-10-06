// P9 of a variant validation (design §10.2; BR-RUA-038; AC-RUA-025, AC-RUA-035, AC-RUA-036):
// `summary/validation-summary.json` built by `buildValidationSummary` from what the runner froze.
// - the trials: each declared trial's outcome (validation-trial-outcomes.ts);
// - the scientific defects outside the trials: the admission evidence (`readAdmissionEvidence`);
// - the terminal reason: `deriveValidationTerminalReason` over the runner and coordination journal
//   events in time order and the original closure;
// - the closure: the frozen cleanup result, the leak audit (`inconclusive` when absent) and the
//   final lease status the coordination journal settles;
// - evidence integrity: the run-level derivation over the declared trials (INV-RUA-001 across them).
// The summary cites the cleanup result and the late-evidence assessment and builds its status on
// the safety assessment, so the absence of any of them fails the SUMMARY phase, as for a run.
//
// Safety checks are not journaled as `safety_check_recorded` events (the supervisor's checks are
// frozen in the safety assessment), so a breach other than the active-time deadline (which ends
// the trials as a `SAFETY_DEADLINE` interruption) is not a terminal reason here; the safety
// standing still keeps the status from `verified` (evidence/CMP-05/decisions.md).

import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { deriveRunEvidenceIntegrity } from '../study-comparison/run-evidence-integrity.ts';
import { finalLeaseStatus } from '../study-comparison/run-terminal-reason.ts';
import { readAdmissionEvidence } from '../variant-validation/admission-evidence.ts';
import { buildValidationSummary } from '../variant-validation/validation-summary.ts';
import { deriveValidationTerminalReason } from '../variant-validation/validation-terminal-reason.ts';
import { inJournalTime, missingSummaryInputs, readClosureRecords } from './closure-records.ts';
import type { SummaryWriter } from './execution-finalization.ts';
import type { ExecutionPackage } from './execution-package.ts';
import { filesByPath } from './execution-package.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import { summaryKindMismatch } from './probe-summary-writer.ts';
import { readValidationTrialOutcomes } from './validation-trial-outcomes.ts';

/**
 * The variant validation summary writer.
 *
 * @example
 * const reasons = await new ValidationSummaryWriter(validator).write(pkg, admitted, finalizedAt); // [] once written
 */
export class ValidationSummaryWriter implements SummaryWriter {
  readonly #validator: RecordValidator;

  constructor(validator: RecordValidator) {
    this.#validator = validator;
  }

  async write(
    pkg: ExecutionPackage,
    admitted: AdmittedExecution,
    finalizedAt: UtcMillis,
  ): Promise<readonly StructuredReason[]> {
    const { identity } = admitted;
    if (identity.execution_kind !== 'VARIANT_VALIDATION') {
      return [summaryKindMismatch(identity.execution_kind, 'VARIANT_VALIDATION')];
    }
    const snapshot = await pkg.snapshot();
    if (!snapshot.ok) {
      return [snapshot.error];
    }
    const deps = { validator: this.#validator, digest: sha256Hex };
    const admission = readAdmissionEvidence(snapshot.value, identity.variant_validation_id, deps);
    if (!admission.ok) {
      return [admission.error];
    }
    const { manifest, execution_manifest_sha256: manifestSha256 } = admission.value;
    const closure = readClosureRecords(filesByPath(snapshot.value), manifestSha256, deps);
    const { cleanup, late_evidence: late, safety } = closure;
    if (cleanup === undefined || late === undefined || safety === undefined) {
      return missingSummaryInputs(closure, ['cleanup', 'late_evidence', 'safety']);
    }
    const trials = readValidationTrialOutcomes(snapshot.value, manifest, manifestSha256, this.#validator);
    const original = {
      cleanup_status: cleanup.record.cleanup_status,
      leak_audit_status: closure.leak_audit?.record.leak_audit_status ?? 'inconclusive',
      lease_status: finalLeaseStatus(closure.lease_events),
    } as const;
    const summary = buildValidationSummary({
      manifest,
      execution_manifest_sha256: manifestSha256,
      trials: trials.outcomes,
      scientific_defects: admission.value.defects,
      terminal_reason: deriveValidationTerminalReason(
        inJournalTime([...closure.runner_events, ...closure.lease_events]),
        original,
      ),
      closure: original,
      safety: safety.record,
      evidence_integrity_status: deriveRunEvidenceIntegrity(manifest.trials, trials.oracle_results).status,
      late_evidence_status: late.record.late_evidence_status,
      cleanup_result_ref: cleanup.ref,
      late_evidence_assessment_ref: late.ref,
      created_at: finalizedAt,
    });
    const unwritten = await pkg.writeOnce(EXECUTION_PATHS.validationSummary, serializeRecordFile(summary));
    return unwritten === undefined ? [] : [unwritten];
  }
}

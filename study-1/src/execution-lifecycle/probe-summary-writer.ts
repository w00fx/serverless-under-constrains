// P9 of a transport probe (design §10.2; CTR-RUA-003; AC-RUA-056): `summary/transport-probe-summary.json`
// from the closure the runner froze. The terminal reason and the probe-result digest come from
// probe-terminal-reason.ts; the closure statuses are the frozen cleanup result, leak audit and
// safety assessment (an absent audit is `inconclusive`, absent safety `unverified`, as for a run),
// the final lease status the coordination journal settles, and the late-evidence assessment's
// status. Like the run summary, it cannot be written without the cleanup result and the
// late-evidence assessment it cites, so their absence fails the SUMMARY phase.
// `COMPLETED` means the lifecycle completed, not that the transport passed.

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, UtcMillis, Uuid4 } from '../record-contract/primitives.ts';
import type { TransportProbeSummary } from '../record-contract/records/group-c/transport_probe_summary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { PackageFiles } from '../study-comparison/record-files.ts';
import { finalLeaseStatus } from '../study-comparison/run-terminal-reason.ts';
import { inJournalTime, missingSummaryInputs, readClosureRecords } from './closure-records.ts';
import type { ExecutionClosureRecords } from './closure-records.ts';
import type { SummaryWriter } from './execution-finalization.ts';
import type { ExecutionPackage } from './execution-package.ts';
import { filesByPath } from './execution-package.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import { deriveProbeTerminalReason } from './probe-terminal-reason.ts';

const PROBE = { kind: 'probe' } as const;

/** What the probe summary is built from. */
export interface ProbeSummaryInput {
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly closure: ExecutionClosureRecords;
  /** The digest of the frozen probe result; undefined when P5 froze none. */
  readonly probe_result_sha256: Sha256Hex | undefined;
  readonly created_at: UtcMillis;
}

/**
 * The transport probe summary writer.
 *
 * @example
 * const reasons = await new TransportProbeSummaryWriter(validator).write(pkg, admitted, finalizedAt); // [] once written
 */
export class TransportProbeSummaryWriter implements SummaryWriter {
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
    if (identity.execution_kind !== 'TRANSPORT_PROBE') {
      return [summaryKindMismatch(identity.execution_kind, 'TRANSPORT_PROBE')];
    }
    const snapshot = await pkg.snapshot();
    if (!snapshot.ok) {
      return [snapshot.error];
    }
    const files = filesByPath(snapshot.value);
    const closure = readClosureRecords(files, admitted.manifest_sha256, {
      validator: this.#validator,
      digest: sha256Hex,
    });
    const summary = buildTransportProbeSummary({
      transport_probe_id: identity.transport_probe_id,
      execution_manifest_sha256: admitted.manifest_sha256,
      closure,
      probe_result_sha256: frozenProbeResultDigest(files),
      created_at: finalizedAt,
    });
    if (!summary.ok) {
      return summary.error;
    }
    const unwritten = await pkg.writeOnce(EXECUTION_PATHS.transportProbeSummary, serializeRecordFile(summary.value));
    return unwritten === undefined ? [] : [unwritten];
  }
}

/**
 * Builds the probe summary, or the reasons it cannot cite its closure.
 *
 * @example
 * const built = buildTransportProbeSummary({ transport_probe_id, execution_manifest_sha256, closure,
 *   probe_result_sha256, created_at });
 * if (built.ok) built.value.probe_terminal_reason; // 'COMPLETED' after a clean lifecycle
 */
export function buildTransportProbeSummary(
  input: ProbeSummaryInput,
): Result<TransportProbeSummary, readonly StructuredReason[]> {
  const { closure } = input;
  const { cleanup, late_evidence: late } = closure;
  if (cleanup === undefined || late === undefined) {
    return err(missingSummaryInputs(closure, ['cleanup', 'late_evidence']));
  }
  const leakAuditStatus = closure.leak_audit?.record.leak_audit_status;
  const terminal = deriveProbeTerminalReason({
    events: inJournalTime([...closure.runner_events, ...closure.lease_events]),
    probe_result_sha256: input.probe_result_sha256,
    cleanup_status: cleanup.record.cleanup_status,
    leak_audit_status: leakAuditStatus,
  });
  return ok({
    schema_version: 1,
    record_type: 'transport_probe_summary',
    transport_probe_id: input.transport_probe_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    ...terminal,
    cleanup_status: cleanup.record.cleanup_status,
    leak_audit_status: leakAuditStatus ?? 'inconclusive',
    lease_status: finalLeaseStatus(closure.lease_events),
    safety_status: closure.safety?.record.safety_status ?? 'unverified',
    late_evidence_status: late.record.late_evidence_status,
    late_evidence_assessment_ref: late.ref,
    created_at: input.created_at,
  });
}

/**
 * The digest of the stored probe result when P5 froze it: the result and the probe evidence index
 * (written last by the freeze) are both stored.
 *
 * @example
 * frozenProbeResultDigest(filesByPath(files)); // the sha256 of probe/derived/transport-probe-result.json
 */
export function frozenProbeResultDigest(files: PackageFiles): Sha256Hex | undefined {
  const result = files.get(PACKAGE_LAYOUT.unitFile(PROBE, 'transportProbeResult'));
  return result === undefined || !files.has(PACKAGE_LAYOUT.unitFile(PROBE, 'evidenceIndex'))
    ? undefined
    : sha256Hex(result);
}

/**
 * The reason a summary writer bound to one kind was handed an execution of another.
 *
 * @example
 * summaryKindMismatch('RUN', 'TRANSPORT_PROBE').code; // 'SUMMARY_KIND_MISMATCH'
 */
export function summaryKindMismatch(actual: string, expected: string): StructuredReason {
  return {
    code: 'SUMMARY_KIND_MISMATCH',
    subject: 'BR-RUA-044',
    detail: `the summary writer was handed a ${actual} execution; expected ${expected}`,
  };
}

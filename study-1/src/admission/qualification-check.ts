// Admission step A10 (QUALIFICATION; BR-RUA-026, BR-RUA-028, design §10.1, §8.11, §8.16): a run
// or a variant validation consumes exactly the probe the operator selected. Its package is
// verified with the selected amendment head; it must be usable; the verified original index and
// head must be exactly the selection's; and its stored, indexed transport-scope snapshot is read
// so A13 can compare it with the recomputation. A transport probe creates the qualification it is
// judged on, so it selects none. Every failure is a qualification rejection.

import { sha256Hex } from '../record-contract/digests.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { ExecutionKind, Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../record-contract/records/group-a/transport_scope_snapshot.ts';
import type { ProbeUsabilityAssessment } from '../record-contract/records/group-c/probe_usability_assessment.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { readProbeRecord } from '../transport-qualification/verdict/probe-package-records.ts';
import { assessProbeUsability } from '../transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../transport-qualification/verdict/probe-usability-reader.ts';
import type { ProbePackageInput } from '../transport-qualification/verdict/probe-usability-reader.ts';
import type { PortFailure, QualificationSelection } from './admission-ports.ts';
import { admissionReason, portFailureReason } from './admission-reason.ts';
import { failed, passed, verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-028';

/** The selected probe's facts an admitted run or validation freezes. */
export interface SelectedProbe {
  readonly selection: QualificationSelection;
  readonly usability: ProbeUsabilityAssessment;
  readonly snapshot: TransportScopeSnapshot;
  readonly snapshot_sha256: Sha256Hex;
}

/**
 * Step A10. A probe passes with `null`; a run or a validation passes with its selected probe.
 *
 * @example
 * const verdict = assessQualification('RUN', selection, await ports.packages.readProbePackage(selection), validator);
 * if (verdict.passed && verdict.value !== null) verdict.value.snapshot_sha256;
 */
export function assessQualification(
  kind: ExecutionKind,
  selection: QualificationSelection | undefined,
  reading: Result<ProbePackageInput, PortFailure> | undefined,
  validator: RecordValidator,
): StepVerdict<SelectedProbe | null> {
  const statement: CheckStatement = {
    subject: 'qualification',
    expected: kind === 'TRANSPORT_PROBE' ? 'no_selected_probe' : 'usable_selected_probe',
    ...(selection === undefined ? {} : { observed: selectionValue(selection) }),
  };
  if (kind === 'TRANSPORT_PROBE') {
    return selection === undefined
      ? passed(null, statement)
      : failed('QUALIFICATION', statement, [
          admissionReason('QUALIFICATION_NOT_ALLOWED', SUBJECT, 'a transport probe selects a probe; expected none'),
        ]);
  }
  if (selection === undefined || reading === undefined) {
    return failed('QUALIFICATION', statement, [
      admissionReason(
        'QUALIFICATION_NOT_SELECTED',
        SUBJECT,
        `a ${kind} selects no probe; expected an explicit --probe`,
      ),
    ]);
  }
  if (!reading.ok) {
    return failed('QUALIFICATION', statement, [
      portFailureReason('PROBE_PACKAGE_UNREADABLE', SUBJECT, 'the selected probe package read', reading.error),
    ]);
  }
  return selectedProbeVerdict(selection, reading.value, validator, statement);
}

function selectedProbeVerdict(
  selection: QualificationSelection,
  input: ProbePackageInput,
  validator: RecordValidator,
  statement: CheckStatement,
): StepVerdict<SelectedProbe | null> {
  const deps = { validator, digest: sha256Hex };
  const usability = assessProbeUsability(readProbeUsabilityInput(input, deps));
  const stored =
    usability.transport_scope_snapshot_sha256 === undefined
      ? undefined
      : readProbeRecord(input.original.files, EXECUTION_PATHS.transportScopeSnapshot, 'transport_scope_snapshot', deps);
  const reasons = [...selectionReasons(selection, input, usability), ...usability.reasons];
  if (stored === undefined) {
    return failed('QUALIFICATION', statement, [missingSnapshot(), ...reasons]);
  }
  return verdictOf('QUALIFICATION', statement, reasons, {
    selection,
    usability,
    snapshot: stored.record,
    snapshot_sha256: stored.sha256,
  });
}

function selectionReasons(
  selection: QualificationSelection,
  input: ProbePackageInput,
  usability: ProbeUsabilityAssessment,
): readonly StructuredReason[] {
  const mismatches: readonly (readonly [string, string, string | null])[] = [
    ['transport_probe_id', selection.transport_probe_id, input.identity.transport_probe_id],
    ['original_package_index_sha256', selection.original_package_index_sha256, usability.original_package_index_sha256],
    [
      'amendment_head_sha256',
      String(selection.amendment_head_sha256),
      String(usability.selected_amendment_head_sha256),
    ],
  ];
  return mismatches
    .filter(([, selected, verified]) => selected !== verified)
    .map(([field, selected, verified]) =>
      admissionReason(
        'SELECTION_MISMATCH',
        SUBJECT,
        `the verified ${field} is ${boundedText(String(verified))}; expected the selected ${selected}`,
      ),
    );
}

function selectionValue(selection: QualificationSelection): Readonly<Record<string, string>> {
  return {
    transport_probe_id: selection.transport_probe_id,
    original_package_index_sha256: selection.original_package_index_sha256,
    amendment_head_sha256: selection.amendment_head_sha256 ?? 'none',
  };
}

function missingSnapshot(): StructuredReason {
  return admissionReason(
    'SELECTED_SCOPE_SNAPSHOT_MISSING',
    SUBJECT,
    'the selected probe has no indexed, readable transport-scope snapshot; expected one to compare against',
  );
}

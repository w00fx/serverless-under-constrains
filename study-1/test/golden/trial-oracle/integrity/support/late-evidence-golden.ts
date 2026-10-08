// The AC-RUA-030 late-evidence goldens (BR-RUA-043, design §8.13, D-16). A case's committed fixture
// is a frozen run plus `late-evidence/late-evidence-stream.jsonl`. The frozen evidence is every
// fixture file except `late-evidence/**` (which no evidence index covers, design §7); the subject
// trial's frozen result is the oracle's evaluation of it, stored as its canonical record file, as
// the freeze step stores `derived/oracle-result.json`. The case module names how late monitoring
// ended (`export const monitoring`). The view compared with the expectation is what AC-RUA-030
// names: the status, each reassessment and its changes, whether the frozen result and every frozen
// byte are unchanged, whether the stream is preserved by reference, and whether comparison accepts
// the late evidence (BR-RUA-031 condition LATE_EVIDENCE_ACCEPTABLE).

import type { RawArtifact } from '../../../../../src/evidence-ingestion/ingestion-model.ts';
import { EXECUTION_PATHS } from '../../../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../../src/record-contract/digests.ts';
import { isJsonObject } from '../../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue, UtcMillis, Uuid4 } from '../../../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type { OracleResult } from '../../../../../src/record-contract/records/group-c/oracle_result.ts';
import { deriveComparisonEligibility } from '../../../../../src/study-comparison/comparison-eligibility.ts';
import type { ComparisonEligibilityInput } from '../../../../../src/study-comparison/comparison-eligibility.ts';
import { ingestEvidence } from '../../../../../src/evidence-ingestion/ingest-evidence.ts';
import { evaluateTrial } from '../../../../../src/trial-oracle/evaluate-trial.ts';
import { assessLateEvidence } from '../../../../../src/trial-oracle/late-evidence/assess-late-evidence.ts';
import type { LateMonitoring } from '../../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import { expectedMismatches, loadGoldenCase } from '../../../_harness/golden-harness.ts';
import { ingestionInputFromFiles } from '../../../evidence-ingestion/ingestion-input.ts';
import { CHECKED_AT } from '../../core/support/oracle-golden.ts';
import { INTEGRITY_CASES, INTEGRITY_VALIDATOR, caseExport } from './integrity-golden.ts';

/** When the late evidence is assessed: after monitoring ended in every case. */
export const ASSESSED_AT = '2026-10-05T13:50:00.000Z' as UtcMillis;
const LATE_DIRECTORY = 'late-evidence/';
/** The BR-RUA-031 condition this golden judges, found by its id, never by its position. */
const LATE_CHECK_ID = 'LATE_EVIDENCE_ACCEPTABLE';

/**
 * Where a late-evidence case departs from its contracts and its expectation; empty when it holds.
 *
 * @example
 * assert.deepEqual(await lateEvidenceMismatches('consistent'), []);
 */
export async function lateEvidenceMismatches(caseId: string): Promise<readonly string[]> {
  const caseFile = `${INTEGRITY_CASES}/${caseId}.case.ts`;
  const loaded = await loadGoldenCase(caseFile);
  const subject = loaded.subject_directory;
  const frozenFiles = new Map([...loaded.files].filter(([path]) => !path.startsWith(LATE_DIRECTORY)));
  const frozen = ingestionInputFromFiles(frozenFiles, subject);
  const before = new Map([...frozenFiles].map(([path, bytes]) => [path, sha256Hex(bytes)] as const));
  const result = frozenResult(caseId, frozen);
  const resultBytes = serializeRecordFile(result);
  const resultDigest = sha256Hex(resultBytes);
  const streamBytes = loaded.files.get(EXECUTION_PATHS.lateEvidenceStream);
  const stream: RawArtifact | undefined =
    streamBytes === undefined ? undefined : { path: EXECUTION_PATHS.lateEvidenceStream, bytes: streamBytes };
  const assessed = assessLateEvidence(
    {
      execution: { run_id: result.run_id ?? ('' as Uuid4) },
      execution_manifest_sha256: result.execution_manifest_sha256,
      monitoring: await monitoringOf(caseFile),
      ...(stream === undefined ? {} : { stream }),
      trials: [{ frozen, result: { path: `${subject}/derived/oracle-result.json`, bytes: resultBytes } }],
      assessed_at: ASSESSED_AT,
    },
    INTEGRITY_VALIDATOR,
  );
  if (!assessed.ok) {
    return [`${caseId} late evidence was refused: ${JSON.stringify(assessed.error)}; expected an assessment`];
  }
  const assessment = assessed.value;
  const unchanged =
    sha256Hex(resultBytes) === resultDigest &&
    assessment.reassessments.every((reassessment) => reassessment.frozen_result_ref.artifact_sha256 === resultDigest) &&
    [...frozenFiles].every(([path, bytes]) => before.get(path) === sha256Hex(bytes));
  const actual: JsonValue = {
    ...lateView(assessment, subject),
    frozen_result_unchanged: unchanged,
    late_stream_referenced: assessment.evidence_refs.some(
      (ref) => ref.artifact_path === stream?.path && ref.artifact_sha256 === sha256Hex(stream.bytes),
    ),
    late_evidence_acceptable: lateEvidenceAcceptable(assessment),
  };
  const schema = INTEGRITY_VALIDATOR.validateAs('late_evidence_assessment', assessment as unknown as JsonValue);
  return [
    ...(schema.valid ? [] : [`late_evidence_assessment: ${JSON.stringify(schema.violations)}`]),
    ...expectedMismatches(loaded.golden_case.expected, actual),
  ];
}

function frozenResult(caseId: string, frozen: Parameters<typeof ingestEvidence>[0]): OracleResult {
  const evaluated = evaluateTrial({ evidence: ingestEvidence(frozen, INTEGRITY_VALIDATOR), checked_at: CHECKED_AT });
  if (!evaluated.ok) {
    throw new Error(
      `${caseId} frozen evidence was refused: ${JSON.stringify(evaluated.error)}; expected a frozen result`,
    );
  }
  return evaluated.value.result;
}

// A case module names its monitoring as `export const monitoring`; anything else fails the test.
async function monitoringOf(caseFile: string): Promise<LateMonitoring> {
  const monitoring = await caseExport(caseFile, 'monitoring');
  if (
    !isJsonObject(monitoring as JsonValue) ||
    typeof (monitoring as { readonly outcome?: unknown }).outcome !== 'string'
  ) {
    throw new Error(
      `${caseFile} exports monitoring ${JSON.stringify(monitoring)}; expected { outcome, started_at?, ended_at? }`,
    );
  }
  return monitoring as LateMonitoring;
}

function lateView(assessment: LateEvidenceAssessment, subject: string): JsonObject {
  return {
    late_evidence_status: assessment.late_evidence_status,
    monitoring: assessment.monitoring,
    correlated_record_count: assessment.correlated_record_count,
    reason_codes: assessment.reasons.map((reason) => reason.code),
    reassessments: assessment.reassessments.map((reassessment) => ({
      trial: reassessment.frozen_result_ref.artifact_path.startsWith(`${subject}/`)
        ? '$trial'
        : String(reassessment.trial_id),
      status: reassessment.status,
      changes: reassessment.changes.map(
        (change) => `${change.field}: ${JSON.stringify(change.frozen)} -> ${JSON.stringify(change.reassessed)}`,
      ),
    })),
  };
}

// Only the late-evidence condition is judged here: every other comparison input holds.
function lateEvidenceAcceptable(assessment: LateEvidenceAssessment): boolean {
  const input = {
    trials: [],
    oracle_results: new Map(),
    equality: { projections: [], equality_result: 'pass', reasons: [] },
    evidence_integrity: { status: 'verified', reasons: [] },
    late_evidence: {
      record: assessment,
      ref: { artifact_path: EXECUTION_PATHS.lateEvidenceAssessment, artifact_sha256: sha256Hex(new Uint8Array()) },
    },
    contradictory_amendments: [],
    leak_audit: undefined,
  } as unknown as ComparisonEligibilityInput;
  const late = deriveComparisonEligibility(input).checks.find((check) => check.check_id === LATE_CHECK_ID);
  if (late === undefined) {
    throw new Error(`comparison eligibility has no ${LATE_CHECK_ID} check; expected the BR-RUA-031 late condition`);
  }
  return late.holds;
}

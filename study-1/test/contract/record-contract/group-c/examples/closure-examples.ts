// Group-C examples of operational closure and late evidence: safety, cleanup, leak audit, the
// late-evidence stream and its assessment, and operational recovery (catalogue rows 74-78, 85).

import type { CleanupResult } from '../../../../../src/record-contract/records/group-c/cleanup_result.ts';
import type { LateEvidenceAssessment } from '../../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type { LateEvidenceRecord } from '../../../../../src/record-contract/records/group-c/late_evidence_record.ts';
import type {
  AuditPass,
  LeakAuditResult,
  SurfaceObservation,
} from '../../../../../src/record-contract/records/group-c/leak_audit_result.ts';
import type { OperationalRecoveryRecord } from '../../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { SafetyAssessment } from '../../../../../src/record-contract/records/group-c/safety_assessment.ts';
import {
  COMMIT_TRIPLE,
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  TRIAL_SCOPE,
  VALIDATION_ID,
  at,
  digest,
  reason,
  uuid,
} from '../../group-b/support/record-builders.ts';
import {
  EXECUTION_MANIFEST_PATH,
  RUNNER_JOURNAL_PATH,
  TRIAL_PATHS,
  artifactRef,
  evidenceRef,
} from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const RUN_CORRELATION = { run_id: RUN_ID, execution_manifest_sha256: EXECUTION_MANIFEST_SHA256 } as const;

/**
 * Every safeguard within its declared limit (BR-RUA-046).
 *
 * @example
 * withinLimitsSafety().safety_status; // 'within_limits'
 */
export function withinLimitsSafety(): SafetyAssessment {
  return {
    schema_version: 1,
    record_type: 'safety_assessment',
    ...RUN_CORRELATION,
    safety_status: 'within_limits',
    checks: [
      {
        boundary: 'ACTIVE_TIME',
        declared_limit: '3600000 ms',
        observed: '1200000 ms',
        result: 'within_limits',
        evidence_refs: [evidenceRef(RUNNER_JOURNAL_PATH)],
        checked_at: at(4000),
      },
      {
        boundary: 'ESTIMATED_COST',
        declared_limit: '5.00 USD',
        observed: '0.42 USD',
        result: 'within_limits',
        evidence_refs: [evidenceRef(EXECUTION_MANIFEST_PATH)],
        checked_at: at(4001),
      },
    ],
    reasons: [],
    assessed_at: at(4010),
  };
}

/**
 * A billed-cost check that could not be read leaves the status unverified.
 *
 * @example
 * unverifiedSafety().safety_status; // 'unverified'
 */
export function unverifiedSafety(): SafetyAssessment {
  return {
    schema_version: 1,
    record_type: 'safety_assessment',
    variant_validation_id: VALIDATION_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    safety_status: 'unverified',
    checks: [
      {
        boundary: 'BILLED_COST',
        declared_limit: '5.00 USD',
        result: 'unverified',
        evidence_refs: [],
        checked_at: at(4002),
      },
    ],
    reasons: [reason('BILLING_NOT_FINAL', 'billing export')],
    assessed_at: at(4011),
  };
}

/**
 * A breach outranks every other result (precedence breached > unverified > within_limits).
 *
 * @example
 * breachedSafety().safety_status; // 'breached'
 */
export function breachedSafety(): SafetyAssessment {
  const [activeTime, estimatedCost] = withinLimitsSafety().checks;
  return {
    ...withinLimitsSafety(),
    safety_status: 'breached',
    checks: [{ ...activeTime, observed: '3700000 ms', result: 'breached' }, ...(estimatedCost ? [estimatedCost] : [])],
    reasons: [reason('ACTIVE_TIME', 'runner')],
  };
}

/**
 * A complete cleanup that deleted every owned resource (BR-RUA-048).
 *
 * @example
 * succeededCleanup().cleanup_status; // 'succeeded'
 */
export function succeededCleanup(): CleanupResult {
  return {
    schema_version: 1,
    record_type: 'cleanup_result',
    ...RUN_CORRELATION,
    cleanup_mode: 'NORMAL',
    cleanup_status: 'succeeded',
    steps: [
      { step: 1, status: 'SUCCEEDED', started_at: at(5000), completed_at: at(5001), reasons: [] },
      { step: 2, status: 'SKIPPED', reasons: [reason('NO_LATE_EVIDENCE_WINDOW', 'late evidence')] },
    ],
    resources: [
      {
        resource_type: 'AWS::Lambda::Function',
        resource_identifier: 'rua-provider',
        ownership_basis: 'recorded_stack',
        action: 'DELETED',
        reasons: [],
      },
      {
        resource_type: 'AWS::SQS::Queue',
        resource_identifier: 'rua-source',
        ownership_basis: 'resource_manifest_and_tags',
        action: 'ALREADY_ABSENT',
        reasons: [],
      },
      {
        resource_type: 'AWS::Logs::LogGroup',
        resource_identifier: '/aws/lambda/shared',
        ownership_basis: 'ambiguous',
        action: 'SKIPPED_AMBIGUOUS',
        reasons: [reason('OWNERSHIP_AMBIGUOUS', 'log group')],
      },
      {
        resource_type: 'AWS::IAM::Role',
        resource_identifier: 'baseline-role',
        ownership_basis: 'excluded_baseline',
        action: 'EXCLUDED_BASELINE',
        reasons: [],
      },
    ],
    stopped_durable_execution_arns: ['arn:aws:lambda:eu-west-1:000000000000:function:durable:durable/0002'],
    deleted_dlq_message_ids: ['dlq-message-0001'],
    duration_breach: false,
    started_at: at(5000),
    completed_at: at(5100),
  };
}

/**
 * A deletion that failed makes cleanup partial.
 *
 * @example
 * partialCleanup().cleanup_status; // 'partial'
 */
export function partialCleanup(): CleanupResult {
  return {
    ...succeededCleanup(),
    cleanup_mode: 'EMERGENCY',
    cleanup_status: 'partial',
    resources: [
      {
        resource_type: 'AWS::DynamoDB::Table',
        resource_identifier: 'rua-ledger',
        ownership_basis: 'tags_name_type_created_after_freeze',
        action: 'DELETE_FAILED',
        reasons: [reason('DELETE_THROTTLED', 'ledger table')],
      },
    ],
    duration_breach: true,
  };
}

/**
 * A cleanup still running has no completion time.
 *
 * @example
 * runningCleanup().cleanup_status; // 'running'
 */
export function runningCleanup(): CleanupResult {
  return {
    schema_version: 1,
    record_type: 'cleanup_result',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    cleanup_mode: 'NORMAL',
    cleanup_status: 'running',
    steps: [{ step: 1, status: 'STARTED', started_at: at(5200), reasons: [] }],
    resources: [],
    stopped_durable_execution_arns: [],
    deleted_dlq_message_ids: [],
    duration_breach: false,
    started_at: at(5200),
  };
}

function surface(name: SurfaceObservation['surface'], observed: readonly string[] = []): SurfaceObservation {
  return { surface: name, query_ok: true, observed };
}

function auditPass(offset: number, surfaces: readonly SurfaceObservation[]): AuditPass {
  return { started_at: at(offset), completed_at: at(offset + 50), surfaces };
}

/**
 * Two clean audit passes separated by the stable-absence interval (BR-RUA-051).
 *
 * @example
 * cleanLeakAudit().leak_audit_status; // 'clean'
 */
export function cleanLeakAudit(): LeakAuditResult {
  return {
    schema_version: 1,
    record_type: 'leak_audit_result',
    ...RUN_CORRELATION,
    leak_audit_status: 'clean',
    passes: [
      auditPass(6000, [surface('tag_index'), surface('functions')]),
      auditPass(126000, [surface('tag_index'), surface('functions')]),
    ],
    leaks: [],
    ambiguous: [],
    stable_absence_interval_ms: 120000,
    audited_at: at(126100),
  };
}

/**
 * An audit that found a processing-capable leak (D-30).
 *
 * @example
 * leakingAudit().leak_audit_status; // 'leaks_detected'
 */
export function leakingAudit(): LeakAuditResult {
  return {
    ...cleanLeakAudit(),
    leak_audit_status: 'leaks_detected',
    passes: [auditPass(6000, [surface('functions', ['rua-provider'])])],
    leaks: [
      {
        resource_type: 'AWS::Lambda::Function',
        identifier: 'rua-provider',
        surface: 'functions',
        capability_class: 'processing_capable',
        ownership_basis: 'recorded_stack',
      },
    ],
    stable_absence_interval_ms: 0,
  };
}

/**
 * A failed query makes the audit inconclusive whatever else it saw.
 *
 * @example
 * inconclusiveLeakAudit().leak_audit_status; // 'inconclusive'
 */
export function inconclusiveLeakAudit(): LeakAuditResult {
  return {
    ...cleanLeakAudit(),
    leak_audit_status: 'inconclusive',
    passes: [
      auditPass(6000, [surface('tag_index'), { surface: 'roles', query_ok: false, observed: [] }]),
      auditPass(126000, [surface('tag_index')]),
    ],
    ambiguous: [
      {
        resource_type: 'AWS::Logs::LogGroup',
        identifier: '/aws/lambda/shared',
        surface: 'log_groups',
        reasons: [reason('OWNERSHIP_AMBIGUOUS', 'log group')],
      },
    ],
  };
}

/**
 * A late provider event correlated with the frozen trial (BR-RUA-043).
 *
 * @example
 * correlatedLateRecord().correlated; // true
 */
export function correlatedLateRecord(): LateEvidenceRecord {
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    ...RUN_CORRELATION,
    ...TRIAL_SCOPE,
    sequence: 1,
    captured_at: at(7000),
    late_source: 'PROVIDER_JOURNAL',
    correlated: true,
    late_record_type: 'provider_commit_confirmed',
    late_record: {
      schema_version: 1,
      record_type: 'provider_commit_confirmed',
      provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
    },
  };
}

/**
 * A DLQ message of the probe that matches no frozen evidence.
 *
 * @example
 * uncorrelatedProbeLateRecord().correlated; // false
 */
export function uncorrelatedProbeLateRecord(): LateEvidenceRecord {
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    sequence: 2,
    captured_at: at(7010),
    late_source: 'DLQ',
    correlated: false,
    late_record_type: 'dlq_snapshot',
    late_record: { schema_version: 1, record_type: 'dlq_snapshot' },
  };
}

const FROZEN_ORACLE_RESULT = artifactRef(TRIAL_PATHS.oracleResult);

/**
 * Complete monitoring with no correlated late record: `none` (D-16).
 *
 * @example
 * quietLateEvidence().late_evidence_status; // 'none'
 */
export function quietLateEvidence(): LateEvidenceAssessment {
  return {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    ...RUN_CORRELATION,
    late_evidence_status: 'none',
    monitoring: 'complete',
    monitoring_started_at: at(7000),
    monitoring_ended_at: at(67000),
    correlated_record_count: 0,
    reassessments: [{ frozen_result_ref: FROZEN_ORACLE_RESULT, status: 'none', changes: [] }],
    reasons: [],
    evidence_refs: [evidenceRef('late-evidence/late-evidence-stream.jsonl')],
    assessed_at: at(67100),
  };
}

/**
 * A late commit changes the frozen verdict projection: contradictory (D-16).
 *
 * @example
 * contradictoryLateEvidence().late_evidence_status; // 'contradictory'
 */
export function contradictoryLateEvidence(): LateEvidenceAssessment {
  return {
    ...quietLateEvidence(),
    monitoring: 'complete',
    late_evidence_status: 'contradictory',
    correlated_record_count: 1,
    reassessments: [
      {
        frozen_result_ref: FROZEN_ORACLE_RESULT,
        trial_id: TRIAL_SCOPE.trial_id,
        status: 'contradictory',
        changes: [{ field: '/preservation_verdict', frozen: 'pass', reassessed: 'fail' }],
      },
      {
        frozen_result_ref: artifactRef(`trials/${uuid(0x604)}/derived/oracle-result.json`),
        trial_id: uuid(0x604),
        status: 'consistent',
        changes: [],
      },
    ],
  };
}

/**
 * Monitoring was skipped, so late evidence is unverified and has no monitoring window.
 *
 * @example
 * skippedLateEvidence().monitoring; // 'skipped'
 */
export function skippedLateEvidence(): LateEvidenceAssessment {
  return {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    variant_validation_id: VALIDATION_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    late_evidence_status: 'unverified',
    monitoring: 'skipped',
    correlated_record_count: 0,
    reassessments: [],
    reasons: [reason('EMERGENCY_CLEANUP', 'late evidence monitoring')],
    evidence_refs: [],
    assessed_at: at(7200),
  };
}

/**
 * Recovery reran cleanup steps 3-11 and repaired the leak audit (BR-RUA-038).
 *
 * @example
 * operationalRecovery().record_type; // 'operational_recovery_record'
 */
export function operationalRecovery(): OperationalRecoveryRecord {
  return {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    variant_validation_id: VALIDATION_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    recovery_id: uuid(0x700),
    original_package_index_sha256: digest('validation-package-index'),
    original_closure: {
      cleanup_status: 'partial',
      leak_audit_status: 'leaks_detected',
      lease_status: 'recovery_required',
    },
    recovered_closure: { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' },
    steps_run: [3, 4, 5, 11],
    cleanup_result_ref: artifactRef('cleanup/cleanup-result.json'),
    leak_audit_result_ref: artifactRef('cleanup/leak-audit-result.json'),
    reasons: [],
    started_at: at(8000),
    completed_at: at(8500),
  };
}

export const CLOSURE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('safety_assessment', withinLimitsSafety()),
  groupCExample('safety_assessment (unverified)', unverifiedSafety()),
  groupCExample('safety_assessment (breached)', breachedSafety()),
  groupCExample('cleanup_result', succeededCleanup()),
  groupCExample('cleanup_result (partial)', partialCleanup()),
  groupCExample('cleanup_result (running)', runningCleanup()),
  groupCExample('leak_audit_result', cleanLeakAudit()),
  groupCExample('leak_audit_result (leaks detected)', leakingAudit()),
  groupCExample('leak_audit_result (inconclusive)', inconclusiveLeakAudit()),
  groupCExample('late_evidence_record', correlatedLateRecord()),
  groupCExample('late_evidence_record (probe)', uncorrelatedProbeLateRecord()),
  groupCExample('late_evidence_assessment', quietLateEvidence()),
  groupCExample('late_evidence_assessment (contradictory)', contradictoryLateEvidence()),
  groupCExample('late_evidence_assessment (skipped)', skippedLateEvidence()),
  groupCExample('operational_recovery_record', operationalRecovery()),
];

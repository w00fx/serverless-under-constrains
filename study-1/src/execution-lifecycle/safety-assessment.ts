// The execution's safety assessment (design §7 `summary/safety-assessment.json`, §8.17; BR-RUA-046,
// AC-RUA-049). At P9 the runner freezes the supervisor's two duration checks (active time, frozen
// when active work ended, and total time, which keeps counting through cleanup, so a cleanup that
// ran past the total target is a recorded duration breach) and the admission-time cost check of the
// estimate against the frozen ceiling. Each check cites the frozen execution manifest that declares
// its limit; the status follows the precedence `breached > unverified > within_limits`.

import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { SafetyAssessment, SafetyCheck } from '../record-contract/records/group-c/safety_assessment.ts';
import { estimateWithinCeiling } from '../safety/cost-estimate.ts';
import { deriveSafetyStatus } from '../safety/safety-status.ts';
import type { AdmittedExecution } from './execution-ports.ts';

/**
 * The safety assessment of an execution from the supervisor's checks at `assessedAt`.
 *
 * @example
 * buildSafetyAssessment(admitted, supervisor.checks(), now).safety_status; // 'breached' after a cleanup past the total target
 */
export function buildSafetyAssessment(
  admitted: AdmittedExecution,
  durationChecks: readonly SafetyCheck[],
  assessedAt: UtcMillis,
): SafetyAssessment {
  const manifestRef = { artifact_path: EXECUTION_PATHS.executionManifest, artifact_sha256: admitted.manifest_sha256 };
  const { estimated_cost_usd: estimate } = admitted.manifest.estimates;
  const { ceiling_usd: ceiling } = admitted.manifest.safety;
  const costCheck: SafetyCheck = {
    boundary: 'ESTIMATED_COST',
    declared_limit: `${ceiling} USD`,
    observed: `${estimate} USD`,
    result: estimateWithinCeiling(estimate, ceiling) ? 'within_limits' : 'breached',
    evidence_refs: [],
    checked_at: assessedAt,
  };
  const cited = (check: SafetyCheck): SafetyCheck => ({ ...check, evidence_refs: [manifestRef] });
  const checks: [SafetyCheck, ...SafetyCheck[]] = [cited(costCheck)];
  checks.unshift(...durationChecks.map(cited));
  return {
    schema_version: 1,
    record_type: 'safety_assessment',
    ...executionIdentityFields(admitted.identity),
    execution_manifest_sha256: admitted.manifest_sha256,
    safety_status: deriveSafetyStatus(checks),
    checks,
    reasons: checks.flatMap((check) => (check.result === 'breached' ? [breachReason(check)] : [])),
    assessed_at: assessedAt,
  };
}

function breachReason(check: SafetyCheck): StructuredReason {
  return {
    code: `${check.boundary}_BREACHED`,
    subject: 'BR-RUA-046',
    detail: `${check.boundary} went past its declared limit ${check.declared_limit} (checked at ${check.checked_at}); expected at most the limit`,
  };
}

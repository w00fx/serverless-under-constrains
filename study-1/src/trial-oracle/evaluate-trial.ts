// The trial oracle (design §5.3 `evaluateTrial`, §8.1 pipeline, CTR-RUA-001): ingested evidence
// of one trial in, its oracle result and derived attempt projection out. Pure: the only instant
// it writes is the injected `checked_at`, and it reads no clock, log, metric or trace (AC-RUA-054).
//   gates G1-G8 (§8.3) -> trial validity (§8.4)
//   monetary basis (D-15) -> rules (§8.5) -> preservation verdict (§8.6)
//   terminal reason (§8.7) -> correct completion (§8.8)
//   attempt projection (§8.9), derived only
// Evidence that names no run or variant-validation trial cannot have an oracle result, so it is
// refused with the reason instead (like `buildProbeResult`; evidence/WP-14/decisions.md).

import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { TrialExecutionIdentity } from '../record-contract/records/group-c/shared-shapes.ts';
import type { AttemptProjection } from '../record-contract/records/group-c/attempt_projection.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import { subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { readAttempts } from './attempt-facts.ts';
import { buildAttemptProjection } from './attempt-projection.ts';
import { evaluateBusinessRules } from './business-rules.ts';
import { deriveMonetaryBasis } from './monetary-basis.ts';
import type { MonetaryInputs } from './monetary-basis.ts';
import { businessInputs } from './oracle-inputs.ts';
import type { BusinessInputs } from './oracle-inputs.ts';
import {
  applicableGateValue,
  indeterminateReasons,
  ledgerSnapshotRef,
  scenarioAssessment,
  verdictOutcome,
} from './oracle-result-assembly.ts';
import { derivePreservationVerdict } from './preservation-verdict.ts';
import { deriveTrialValidity } from './trial-validity.ts';
import { assessTreatment, assessValidityGates } from './validity-gates.ts';

export interface OracleInput {
  readonly evidence: IngestedEvidence;
  readonly checked_at: UtcMillis;
}

export interface TrialEvaluation {
  readonly result: OracleResult;
  readonly projection: AttemptProjection;
}

const SUBJECT = 'CTR-RUA-001';

/**
 * Evaluates one trial. Refused, with reasons, when the evidence names no run or variant-validation
 * execution, no execution manifest digest or no trial.
 *
 * @example
 * const evaluation = evaluateTrial({ evidence: ingestEvidence(input, validator), checked_at });
 * if (evaluation.ok) evaluation.value.result.preservation_verdict; // 'pass' | 'fail' | 'indeterminate'
 */
export function evaluateTrial(input: OracleInput): Result<TrialEvaluation, readonly StructuredReason[]> {
  const { evidence } = input;
  const { execution, execution_manifest_sha256: manifestDigest, trial } = evidence.scope;
  if (execution === undefined || execution.execution_kind === 'TRANSPORT_PROBE' || manifestDigest === undefined) {
    const detail = `the evidence names execution kind ${execution?.execution_kind ?? '(none)'}; expected a RUN or VARIANT_VALIDATION execution manifest`;
    return err([{ code: 'TRIAL_EXECUTION_UNKNOWN', subject: SUBJECT, detail }]);
  }
  if (trial === undefined) {
    const detail =
      'the evidence names no trial (its trial manifest is missing or unusable); expected one trial manifest';
    return err([{ code: 'TRIAL_UNKNOWN', subject: SUBJECT, detail }]);
  }
  const treatment = assessTreatment(evidence);
  const { gates, terminal } = assessValidityGates(evidence, treatment);
  const validity = deriveTrialValidity(gates);
  const inputs = businessInputs(evidence);
  const attempts = readAttempts(evidence);
  const basis = deriveMonetaryBasis(
    new Map(gates.map((gate) => [gate.gate, gate.value] as const)),
    monetaryInputs(evidence, inputs),
  );
  const { rules, monetary_observations } = evaluateBusinessRules(evidence, { basis, gates, inputs, attempts });
  const verdict = derivePreservationVerdict(validity, rules);
  const identity = trialExecutionIdentity(execution);
  const result: OracleResult = {
    schema_version: 1,
    record_type: 'oracle_result',
    ...identity,
    execution_manifest_sha256: manifestDigest,
    trial_id: trial.trial_id,
    trial_manifest_sha256: trial.trial_manifest_sha256,
    variant_id: trial.variant_id,
    ...verdictOutcome(verdict, terminal.reason),
    trial_validity: validity,
    validity_gates: gates,
    identity_integrity: applicableGateValue(gates[2].value),
    ...scenarioAssessment(treatment, gates[3]),
    rule_results: rules,
    indeterminate_reasons: indeterminateReasons(gates, rules),
    ledger_snapshot_ref: ledgerSnapshotRef(evidence),
    monetary_observations,
    checked_at: input.checked_at,
  };
  const projection = buildAttemptProjection(
    evidence,
    attempts,
    {
      execution: identity,
      execution_manifest_sha256: manifestDigest,
      trial_id: trial.trial_id,
      trial_manifest_sha256: trial.trial_manifest_sha256,
    },
    input.checked_at,
  );
  return ok({ result, projection });
}

function trialExecutionIdentity(
  execution: Exclude<ExecutionIdentity, { readonly execution_kind: 'TRANSPORT_PROBE' }>,
): TrialExecutionIdentity {
  return execution.execution_kind === 'RUN'
    ? { run_id: execution.run_id }
    : { variant_validation_id: execution.variant_validation_id };
}

function monetaryInputs(evidence: IngestedEvidence, inputs: BusinessInputs): MonetaryInputs {
  const ledger = subjectArtifactState(evidence, 'ledger_snapshot');
  return {
    ledger: { given: ledger.ref !== undefined, present: evidence.ledger.snapshot !== undefined, path: ledger.path },
    payment: {
      given: inputs.payment.ref !== undefined,
      present: inputs.payment.record !== undefined,
      path: inputs.payment.path,
    },
    decision: {
      given: inputs.decision.ref !== undefined,
      present: inputs.decision.record !== undefined,
      path: inputs.decision.path,
    },
  };
}

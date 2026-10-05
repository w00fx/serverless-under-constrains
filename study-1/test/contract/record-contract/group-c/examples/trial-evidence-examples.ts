// Group-C examples of the derived trial evidence: the attempt projection, the oracle result and
// the evidence index (catalogue rows 66-68). Each variant exercises another branch of a
// conditional rule of its schema.

import type { GateValue, RuleOutcome } from '../../../../../src/record-contract/primitives.ts';
import type { AttemptProjection } from '../../../../../src/record-contract/records/group-c/attempt_projection.ts';
import type { EvidenceIndex } from '../../../../../src/record-contract/records/group-c/evidence_index.ts';
import type {
  OracleResult,
  RuleResult,
  ValidityGate,
} from '../../../../../src/record-contract/records/group-c/oracle_result.ts';
import { GATE_IDS, ORACLE_RULE_IDS } from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { GateId, OracleRuleId } from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  TRIAL_SCOPE,
  VALIDATION_ID,
  at,
  ns,
  reason,
  uuid,
} from '../../group-b/support/record-builders.ts';
import { TRIAL_DIRECTORY, artifactRef, evidenceRef, indexEntry, sixConditions } from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const LEDGER_SNAPSHOT = `${TRIAL_DIRECTORY}/ledger-snapshot.json`;

export function attemptProjection(): AttemptProjection {
  return {
    schema_version: 1,
    record_type: 'attempt_projection',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    ...TRIAL_SCOPE,
    attempts: [
      {
        ...ATTEMPT_CORRELATION,
        registered_event_id: uuid(0x501),
        invocation: {
          source: 'conventional_caller',
          source_instance_id: uuid(0x201),
          message_id: 'message-0001',
          receive_count: 1,
        },
        dispatch_state: 'DISPATCHED',
        outcome: 'TIMED_OUT',
        outcome_class: 'AMBIGUOUS',
        provider_call_id: COMMIT_TRIPLE.provider_call_id,
        provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
        late_transport_settlement: { settlement_kind: 'resolved', observed_after_elapsed_ns: ns(250_000_000n) },
        knowledge_after_derived: 'ONE_EFFECT_CONFIRMED',
        knowledge_after_recorded: 'UNKNOWN',
      },
    ],
    provider_calls: [
      {
        provider_call_id: COMMIT_TRIPLE.provider_call_id,
        received_event_id: uuid(0x502),
        disposition: 'ACCEPTED',
        attempt_id: ATTEMPT_CORRELATION.attempt_id,
        provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
      },
      {
        provider_call_id: uuid(0x403),
        received_event_id: uuid(0x503),
        disposition: 'REJECTED',
        rejection_reason: 'AMOUNT_INVALID',
      },
      { provider_call_id: uuid(0x404), received_event_id: uuid(0x504), disposition: 'UNRESOLVED' },
    ],
    transactions: [{ ...COMMIT_TRIPLE, ledger_ref: evidenceRef(LEDGER_SNAPSHOT) }],
    durable_executions: [],
    derived_at: at(900),
  };
}

export function probeAttemptProjection(): AttemptProjection {
  return {
    schema_version: 1,
    record_type: 'attempt_projection',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    attempts: [
      {
        ...ATTEMPT_CORRELATION,
        registered_event_id: uuid(0x511),
        invocation: {
          source: 'probe_caller',
          source_instance_id: uuid(0x211),
          durable_execution_arn: 'arn:aws:lambda:eu-west-1:000000000000:function:probe:durable/0001',
          step_attempt: 1,
        },
        dispatch_state: 'NOT_DISPATCHED',
        outcome_class: 'PRE_DISPATCH_FAILURE',
        knowledge_after_derived: 'NOT_ATTEMPTED',
      },
    ],
    provider_calls: [],
    transactions: [],
    durable_executions: [
      {
        durable_execution_arn: 'arn:aws:lambda:eu-west-1:000000000000:function:probe:durable/0001',
        status: 'SUCCEEDED',
      },
    ],
    derived_at: at(910),
  };
}

function validityGate(gate: GateId, value: GateValue): ValidityGate {
  const evidence_refs = value === 'verified' ? [evidenceRef(`${TRIAL_DIRECTORY}/evidence-index.json`)] : [];
  const reasons = value === 'verified' || value === 'not_applicable' ? [] : [reason('GATE_NOT_VERIFIED', gate)];
  return { gate, value, reasons, evidence_refs };
}

type Gates = OracleResult['validity_gates'];

function validityGates(valueOf: (gate: GateId) => GateValue): Gates {
  const [g1, g2, g3, g4a, g4b, g5, g6, g7, g8] = GATE_IDS;
  return [
    validityGate(g1, valueOf(g1)),
    validityGate(g2, valueOf(g2)),
    validityGate(g3, valueOf(g3)),
    validityGate(g4a, valueOf(g4a)),
    validityGate(g4b, valueOf(g4b)),
    validityGate(g5, valueOf(g5)),
    validityGate(g6, valueOf(g6)),
    validityGate(g7, valueOf(g7)),
    validityGate(g8, valueOf(g8)),
  ];
}

function ruleResult(ruleId: OracleRuleId, result: RuleOutcome): RuleResult {
  return {
    rule_id: ruleId,
    result,
    expected: { successful_transactions: 1 },
    observed:
      result === 'indeterminate'
        ? { ledger: 'incomplete' }
        : { successful_transactions: 1, ids: [COMMIT_TRIPLE.provider_transaction_id] },
    evidence_refs: result === 'pass' ? [evidenceRef(LEDGER_SNAPSHOT)] : [],
    indeterminate_reasons: result === 'indeterminate' ? [reason('LEDGER_PAGINATION_INCOMPLETE', ruleId)] : [],
  };
}

function ruleResults(resultOf: (rule: OracleRuleId) => RuleOutcome): OracleResult['rule_results'] {
  const [r1, r2, r3, r4, r5, r7, r8, r9, inv1, r25] = ORACLE_RULE_IDS;
  return [
    ruleResult(r1, resultOf(r1)),
    ruleResult(r2, resultOf(r2)),
    ruleResult(r3, resultOf(r3)),
    ruleResult(r4, resultOf(r4)),
    ruleResult(r5, resultOf(r5)),
    ruleResult(r7, resultOf(r7)),
    ruleResult(r8, resultOf(r8)),
    ruleResult(r9, resultOf(r9)),
    ruleResult(inv1, resultOf(inv1)),
    ruleResult(r25, resultOf(r25)),
  ];
}

const ORACLE_COMMON = {
  schema_version: 1,
  record_type: 'oracle_result',
  execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
  trial_id: TRIAL_ID,
  trial_manifest_sha256: TRIAL_MANIFEST_SHA256,
  ledger_snapshot_ref: artifactRef(LEDGER_SNAPSHOT),
  monetary_observations: {
    successful_transaction_count: 1,
    refunded_total_minor: ns(2500n),
    provider_transaction_ids: [COMMIT_TRIPLE.provider_transaction_id],
    ledger_complete: true,
  },
  checked_at: at(1000),
} as const;

/** A passing CONTROL trial of the run that completed (BR-RUA-030: correct completion). */
export function controlPassOracleResult(): OracleResult {
  return {
    ...ORACLE_COMMON,
    run_id: RUN_ID,
    variant_id: 'conventional',
    scenario: 'CONTROL',
    preservation_verdict: 'pass',
    correct_completion: true,
    processing_terminal_reason: 'SUCCEEDED',
    trial_validity: 'valid',
    validity_gates: validityGates((gate) => (gate === 'treatment_fidelity' ? 'not_applicable' : 'verified')),
    identity_integrity: 'verified',
    control_integrity: 'verified',
    treatment_fidelity: 'not_applicable',
    fidelity_basis: 'not_applicable',
    clock_assumption_refs: [],
    rule_results: ruleResults((rule) => (rule === 'BR-RUA-025' ? 'not_applicable' : 'pass')),
    treatment_condition_results: [],
    indeterminate_reasons: [],
  };
}

/** A passing treatment trial of a variant validation whose processing ended without success. */
export function treatmentPassOracleResult(): OracleResult {
  return {
    ...ORACLE_COMMON,
    variant_validation_id: VALIDATION_ID,
    variant_id: 'durable',
    scenario: 'COMMIT_THEN_TIMEOUT',
    preservation_verdict: 'pass',
    correct_completion: false,
    processing_terminal_reason: 'RETRIES_EXHAUSTED',
    trial_validity: 'valid',
    validity_gates: validityGates((gate) => (gate === 'control_integrity' ? 'not_applicable' : 'verified')),
    identity_integrity: 'verified',
    control_integrity: 'not_applicable',
    treatment_fidelity: 'verified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    rule_results: ruleResults(() => 'pass'),
    treatment_condition_results: sixConditions('pass'),
    indeterminate_reasons: [],
  };
}

/** A treatment trial that is not valid, so its verdict is indeterminate (BR-RUA-006). */
export function indeterminateOracleResult(): OracleResult {
  return {
    ...ORACLE_COMMON,
    run_id: RUN_ID,
    variant_id: 'durable',
    scenario: 'COMMIT_THEN_TIMEOUT',
    preservation_verdict: 'indeterminate',
    correct_completion: null,
    processing_terminal_reason: null,
    trial_validity: 'indeterminate',
    validity_gates: validityGates((gate) => (gate === 'control_integrity' ? 'not_applicable' : 'unverified')),
    identity_integrity: 'unverified',
    control_integrity: 'not_applicable',
    treatment_fidelity: 'unverified',
    fidelity_basis: 'causal',
    clock_assumption_refs: [],
    rule_results: ruleResults(() => 'indeterminate'),
    treatment_condition_results: sixConditions('pass', ['BR-RUA-013', 'indeterminate']),
    indeterminate_reasons: [reason('SETTLEMENT_NOT_ESTABLISHED', 'settlement')],
  };
}

/** A failing CONTROL trial: two successful transactions for one decision (BR-RUA-001). */
export function controlFailOracleResult(): OracleResult {
  return {
    ...controlPassOracleResult(),
    preservation_verdict: 'fail',
    correct_completion: false,
    processing_terminal_reason: 'SUCCEEDED',
    rule_results: ruleResults((rule) => (rule === 'BR-RUA-001' ? 'fail' : 'pass')),
  };
}

export function trialEvidenceIndex(): EvidenceIndex {
  return {
    schema_version: 1,
    record_type: 'evidence_index',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    ...TRIAL_SCOPE,
    index_scope: 'TRIAL',
    entries: [
      indexEntry('execution-manifest.json', 'execution_manifest'),
      indexEntry(`${TRIAL_DIRECTORY}/caller-journal.jsonl`, 'caller_journal'),
      indexEntry(`${TRIAL_DIRECTORY}/derived/oracle-result.json`, 'oracle_result', 'derived'),
    ],
    created_at: at(1100),
  };
}

export function probeEvidenceIndex(): EvidenceIndex {
  return {
    schema_version: 1,
    record_type: 'evidence_index',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    index_scope: 'PROBE',
    entries: [
      indexEntry('probe/derived/transport-probe-result.json', 'transport_probe_result', 'derived'),
      indexEntry('probe/provider-journal.jsonl', 'provider_journal'),
    ],
    created_at: at(1110),
  };
}

export const TRIAL_EVIDENCE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('attempt_projection', attemptProjection()),
  groupCExample('attempt_projection (probe)', probeAttemptProjection()),
  groupCExample('oracle_result', controlPassOracleResult()),
  groupCExample('oracle_result (treatment pass)', treatmentPassOracleResult()),
  groupCExample('oracle_result (indeterminate)', indeterminateOracleResult()),
  groupCExample('oracle_result (control fail)', controlFailOracleResult()),
  groupCExample('evidence_index', trialEvidenceIndex()),
  groupCExample('evidence_index (probe)', probeEvidenceIndex()),
];

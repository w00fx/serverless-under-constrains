// Group-C examples of the oracle result (catalogue row 67). Each one is a spec-faithful result of
// one BR-RUA-029 verdict-matrix row: the gates follow design §8.3, the rules follow design §8.5
// (BR-RUA-007 `not_applicable` per trial, the mirror rules equal their gates, the monetary
// rules agree with the stated ledger), every pass or fail cites evidence (BR-RUA-035), and the
// verdict reasons are the design §8.6 union of the non-verified gates and indeterminate rules.

import { compareEvidenceRefs } from '../../../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../../../../../src/record-contract/evidence-refs.ts';
import type {
  GateValue,
  JsonValue,
  RuleOutcome,
  StructuredReason,
  Uuid4,
} from '../../../../../src/record-contract/primitives.ts';
import type {
  MonetaryObservations,
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
  PAYMENT_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  VALIDATION_ID,
  at,
  ns,
  reason,
  uuid,
} from '../../group-b/support/record-builders.ts';
import { TRIAL_PATHS, artifactRef, evidenceRef, sixConditions } from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

/** D-31: approved amount = captured amount, in BRL (group-A input examples). */
const AMOUNT_MINOR = 10_000;
const REFUND_REQUEST_ID = ATTEMPT_CORRELATION.refund_request_id;
const SECOND_TRANSACTION_ID = uuid(0x405);
const ATTEMPT_REGISTERED_EVENT_ID = uuid(0x501);
const REQUEST_STATE_EVENT_ID = uuid(0x506);

type ApplicableValue = Exclude<GateValue, 'not_applicable'>;
type Gates = Readonly<Record<GateId, GateValue>>;
type Rules = OracleResult['rule_results'];

/** Design §8.5 mirror rules: verified → pass, invalid → fail, unverified → indeterminate. */
const MIRRORED: Readonly<Record<ApplicableValue, RuleOutcome>> = {
  verified: 'pass',
  invalid: 'fail',
  unverified: 'indeterminate',
};

function sortedRefs(...refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return refs.toSorted(compareEvidenceRefs);
}

/** The payment, the decision and one ledger pointer per transaction; never a journal (AC-RUA-006). */
function ledgerRefs(transactionCount: number): readonly EvidenceRef[] {
  const transactions = Array.from({ length: transactionCount }, (_unused, index) =>
    evidenceRef(TRIAL_PATHS.ledgerSnapshot, { json_pointer: `/transactions/${String(index)}` }),
  );
  return sortedRefs(evidenceRef(TRIAL_PATHS.payment), evidenceRef(TRIAL_PATHS.approvedDecision), ...transactions);
}

/** Each gate cites the files its design §8.3 row reads. */
const GATE_EVIDENCE: Readonly<Record<GateId, readonly EvidenceRef[]>> = {
  independent_oracle: [evidenceRef(TRIAL_PATHS.ledgerSnapshot)],
  traceability: [evidenceRef(TRIAL_PATHS.callerJournal)],
  identity_integrity: [evidenceRef(TRIAL_PATHS.callerJournal)],
  control_integrity: sortedRefs(evidenceRef(TRIAL_PATHS.callerJournal), evidenceRef(TRIAL_PATHS.providerJournal)),
  treatment_fidelity: sortedRefs(evidenceRef(TRIAL_PATHS.controllerJournal), evidenceRef(TRIAL_PATHS.providerJournal)),
  ledger_access: [evidenceRef(TRIAL_PATHS.ledgerSnapshot)],
  settlement: [evidenceRef(TRIAL_PATHS.settlementSamples)],
  rule_evidence: sortedRefs(evidenceRef(TRIAL_PATHS.callerJournal), evidenceRef(TRIAL_PATHS.ledgerSnapshot)),
  evidence_integrity: [evidenceRef(TRIAL_PATHS.evidenceIndex)],
};

function gateReason(gate: GateId, value: ApplicableValue): StructuredReason {
  return reason(`GATE_${value.toUpperCase()}`, gate);
}

function validityGate(gate: GateId, value: GateValue): ValidityGate {
  if (value === 'verified' || value === 'not_applicable') {
    return { gate, value, reasons: [], evidence_refs: value === 'verified' ? GATE_EVIDENCE[gate] : [] };
  }
  return {
    gate,
    value,
    reasons: [gateReason(gate, value)],
    evidence_refs: value === 'invalid' ? GATE_EVIDENCE[gate] : [],
  };
}

function validityGates(gates: Gates): OracleResult['validity_gates'] {
  const [g1, g2, g3, g4a, g4b, g5, g6, g7, g8] = GATE_IDS;
  return [
    validityGate(g1, gates[g1]),
    validityGate(g2, gates[g2]),
    validityGate(g3, gates[g3]),
    validityGate(g4a, gates[g4a]),
    validityGate(g4b, gates[g4b]),
    validityGate(g5, gates[g5]),
    validityGate(g6, gates[g6]),
    validityGate(g7, gates[g7]),
    validityGate(g8, gates[g8]),
  ];
}

function applicable(value: GateValue): ApplicableValue {
  if (value === 'not_applicable') {
    throw new Error(`example gate value ${value}; expected verified, invalid or unverified (design §8.3)`);
  }
  return value;
}

interface RuleFacts {
  readonly result: RuleOutcome;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly evidence_refs?: readonly EvidenceRef[];
  readonly indeterminate_reasons?: readonly StructuredReason[];
}

function rule(ruleId: OracleRuleId, facts: RuleFacts): RuleResult {
  return {
    rule_id: ruleId,
    result: facts.result,
    expected: facts.expected,
    observed: facts.observed,
    evidence_refs: facts.evidence_refs ?? [],
    indeterminate_reasons: facts.indeterminate_reasons ?? [],
  };
}

/** A mirror rule (design §8.5): its result follows its gate, and it cites the gate's evidence. */
function mirrorRule(ruleId: OracleRuleId, gate: GateId, value: ApplicableValue): RuleResult {
  const result = MIRRORED[value];
  const conclusive = result !== 'indeterminate';
  return rule(ruleId, {
    result,
    expected: { gate, value: 'verified' },
    observed: { gate, value },
    evidence_refs: conclusive ? GATE_EVIDENCE[gate] : [],
    indeterminate_reasons: conclusive ? [] : [gateReason(gate, value)],
  });
}

/** The ledger an example states: the successful transactions for its one refund decision. */
interface Ledger {
  readonly transactionIds: readonly Uuid4[];
  /** D-15: false unless G1, G5 and G6 are verified; the monetary rules are then indeterminate. */
  readonly conclusive: boolean;
}

function monetaryObservations(ledger: Ledger): MonetaryObservations {
  return {
    successful_transaction_count: ledger.transactionIds.length,
    refunded_total_minor: ns(BigInt(AMOUNT_MINOR * ledger.transactionIds.length)),
    provider_transaction_ids: ledger.transactionIds,
    ledger_complete: true,
  };
}

function monetaryRule(
  ruleId: OracleRuleId,
  ledger: Ledger,
  holds: boolean,
  values: Pick<RuleFacts, 'expected' | 'observed'>,
): RuleResult {
  if (!ledger.conclusive) {
    return rule(ruleId, {
      ...values,
      result: 'indeterminate',
      indeterminate_reasons: [reason('SETTLEMENT_NOT_ESTABLISHED', ruleId)],
    });
  }
  return rule(ruleId, {
    ...values,
    result: holds ? 'pass' : 'fail',
    evidence_refs: ledgerRefs(ledger.transactionIds.length),
  });
}

/** BR-RUA-004 (D-03): `not_applicable` without an ambiguous outcome, else judged on the recorded states. */
function knowledgeRule(outcome: RuleOutcome): RuleResult {
  const expected = { after_first_ambiguous: 'UNKNOWN' };
  if (outcome === 'not_applicable') {
    return rule('BR-RUA-004', { result: outcome, expected, observed: { ambiguous_outcomes: 0 } });
  }
  if (outcome === 'indeterminate') {
    return rule('BR-RUA-004', {
      result: outcome,
      expected,
      observed: { request_state_versions: [1, 3] },
      indeterminate_reasons: [reason('REQUEST_STATE_VERSIONS_NOT_DENSE', 'BR-RUA-004')],
    });
  }
  return rule('BR-RUA-004', {
    result: outcome,
    expected,
    observed: { recorded: outcome === 'pass' ? ['UNKNOWN'] : ['ONE_EFFECT_CONFIRMED'] },
    evidence_refs: [evidenceRef(TRIAL_PATHS.callerJournal, { event_id: REQUEST_STATE_EVENT_ID })],
  });
}

function ruleResults(gates: Gates, ledger: Ledger, br004: RuleOutcome): Rules {
  const count = ledger.transactionIds.length;
  const g4: GateId = gates.control_integrity === 'not_applicable' ? 'treatment_fidelity' : 'control_integrity';
  const [r1, r2, r3, , r5, r7, r8, r9, inv1, r25] = ORACLE_RULE_IDS;
  return [
    monetaryRule(r1, ledger, count === 1, {
      expected: { count: 1, refund_request_id: REFUND_REQUEST_ID },
      observed: { count, provider_transaction_ids: ledger.transactionIds },
    }),
    monetaryRule(r2, ledger, count <= 1, {
      expected: { max_total_minor: String(AMOUNT_MINOR) },
      observed: { total_minor: String(AMOUNT_MINOR * count), transaction_count: count },
    }),
    rule(r3, {
      result: 'pass',
      expected: { refund_request_ids: [REFUND_REQUEST_ID] },
      observed: { refund_request_ids: [REFUND_REQUEST_ID] },
      evidence_refs: [evidenceRef(TRIAL_PATHS.callerJournal, { event_id: ATTEMPT_REGISTERED_EVENT_ID })],
    }),
    knowledgeRule(br004),
    mirrorRule(r5, 'independent_oracle', applicable(gates.independent_oracle)),
    rule(r7, {
      result: 'not_applicable',
      expected: { evaluated_in: 'comparison_assessment' },
      observed: { reason: 'EVALUATED_IN_COMPARISON' },
    }),
    mirrorRule(r8, 'traceability', applicable(gates.traceability)),
    monetaryRule(r9, ledger, count === 1, {
      expected: [
        {
          refund_request_id: REFUND_REQUEST_ID,
          payment_id: PAYMENT_ID,
          amount_minor: AMOUNT_MINOR,
          currency: 'BRL',
          status: 'SUCCEEDED',
        },
      ],
      observed: ledger.transactionIds.map((id) => ({ provider_transaction_id: id, mismatches: [] })),
    }),
    mirrorRule(inv1, 'identity_integrity', applicable(gates.identity_integrity)),
    mirrorRule(r25, g4, applicable(gates[g4])),
  ];
}

/** Design §8.6: reasons of every non-verified gate and indeterminate rule, deduplicated, by (subject, code). */
function verdictReasons(gates: OracleResult['validity_gates'], rules: Rules): readonly StructuredReason[] {
  const byKey = new Map<string, StructuredReason>();
  const indeterminate = rules.filter((entry) => entry.result === 'indeterminate');
  for (const entry of [
    ...gates.flatMap((gate) => gate.reasons),
    ...indeterminate.flatMap((r) => r.indeterminate_reasons),
  ]) {
    byKey.set(`${entry.subject}\u0000${entry.code}`, entry);
  }
  return [...byKey.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, entry]) => entry);
}

type DerivedFields = Pick<
  OracleResult,
  'validity_gates' | 'rule_results' | 'indeterminate_reasons' | 'monetary_observations' | 'identity_integrity'
>;

/** The fields an oracle result derives from its gates, its ledger and its BR-RUA-004 outcome. */
function derivedFields(gates: Gates, ledger: Ledger, br004: RuleOutcome): DerivedFields {
  const validity_gates = validityGates(gates);
  const rule_results = ruleResults(gates, ledger, br004);
  return {
    validity_gates,
    rule_results,
    indeterminate_reasons: verdictReasons(validity_gates, rule_results),
    monetary_observations: monetaryObservations(ledger),
    identity_integrity: applicable(gates.identity_integrity),
  };
}

const CONTROL_GATES: Gates = {
  independent_oracle: 'verified',
  traceability: 'verified',
  identity_integrity: 'verified',
  control_integrity: 'verified',
  treatment_fidelity: 'not_applicable',
  ledger_access: 'verified',
  settlement: 'verified',
  rule_evidence: 'verified',
  evidence_integrity: 'verified',
};
const TREATMENT_GATES: Gates = {
  ...CONTROL_GATES,
  control_integrity: 'not_applicable',
  treatment_fidelity: 'verified',
};
const UNSETTLED_TREATMENT_GATES: Gates = {
  ...TREATMENT_GATES,
  independent_oracle: 'unverified',
  treatment_fidelity: 'unverified',
  settlement: 'unverified',
};
const CONFLICTED_TREATMENT_GATES: Gates = { ...TREATMENT_GATES, treatment_fidelity: 'invalid' };

const ONE_TRANSACTION: Ledger = { transactionIds: [COMMIT_TRIPLE.provider_transaction_id], conclusive: true };
const TWO_TRANSACTIONS: Ledger = {
  transactionIds: [COMMIT_TRIPLE.provider_transaction_id, SECOND_TRANSACTION_ID],
  conclusive: true,
};

const ORACLE_COMMON = {
  schema_version: 1,
  record_type: 'oracle_result',
  execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
  trial_id: TRIAL_ID,
  trial_manifest_sha256: TRIAL_MANIFEST_SHA256,
  ledger_snapshot_ref: artifactRef(TRIAL_PATHS.ledgerSnapshot),
  checked_at: at(1000),
} as const;

/**
 * Matrix row 1: a valid CONTROL trial with one exact transaction and successful terminal processing.
 *
 * @example
 * controlPassOracleResult().preservation_verdict; // 'pass'
 */
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
    ...derivedFields(CONTROL_GATES, ONE_TRANSACTION, 'not_applicable'),
    control_integrity: 'verified',
    treatment_fidelity: 'not_applicable',
    fidelity_basis: 'not_applicable',
    clock_assumption_refs: [],
    treatment_condition_results: [],
  };
}

/**
 * Matrix row 7: a verified treatment trial of a variant validation with one exact transaction
 * whose processing ended in the DLQ, so it passes without correct completion (AC-RUA-052).
 *
 * @example
 * treatmentPassOracleResult().correct_completion; // false
 */
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
    ...derivedFields(TREATMENT_GATES, ONE_TRANSACTION, 'pass'),
    control_integrity: 'not_applicable',
    treatment_fidelity: 'verified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    treatment_condition_results: sixConditions('pass'),
  };
}

/**
 * Matrix row 8: processing is still active at the deadline. G6 has no terminal reason (D-17),
 * G1 cannot place the snapshot in a settled window, so the monetary rules are indeterminate
 * (D-15); one condition is indeterminate, so G4b is unverified.
 *
 * @example
 * indeterminateOracleResult().trial_validity; // 'indeterminate'
 */
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
    ...derivedFields(UNSETTLED_TREATMENT_GATES, { ...ONE_TRANSACTION, conclusive: false }, 'pass'),
    control_integrity: 'not_applicable',
    treatment_fidelity: 'unverified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    treatment_condition_results: sixConditions('pass', ['BR-RUA-013', 'indeterminate']),
  };
}

/**
 * Matrix row 4 (case a): a conflicting signal makes G4b invalid, so the trial is invalid and
 * indeterminate while the conclusive ledger still reports the two-transaction rule failures (D-15).
 *
 * @example
 * invalidTreatmentOracleResult().rule_results[0].result; // 'fail'
 */
export function invalidTreatmentOracleResult(): OracleResult {
  return {
    ...ORACLE_COMMON,
    run_id: RUN_ID,
    variant_id: 'durable',
    scenario: 'COMMIT_THEN_TIMEOUT',
    preservation_verdict: 'indeterminate',
    correct_completion: null,
    processing_terminal_reason: 'SUCCEEDED',
    trial_validity: 'invalid',
    ...derivedFields(CONFLICTED_TREATMENT_GATES, TWO_TRANSACTIONS, 'pass'),
    control_integrity: 'not_applicable',
    treatment_fidelity: 'invalid',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    treatment_condition_results: sixConditions('pass', ['BR-RUA-013', 'fail']),
  };
}

/**
 * Matrix row 10: a valid CONTROL trial whose ledger proves two transactions for one decision, so
 * BR-RUA-001, -002 and -009 fail (AC-RUA-004, AC-RUA-054).
 *
 * @example
 * controlFailOracleResult().monetary_observations.successful_transaction_count; // 2
 */
export function controlFailOracleResult(): OracleResult {
  return {
    ...controlPassOracleResult(),
    preservation_verdict: 'fail',
    correct_completion: false,
    processing_terminal_reason: 'SUCCEEDED',
    ...derivedFields(CONTROL_GATES, TWO_TRANSACTIONS, 'not_applicable'),
  };
}

/**
 * A valid treatment trial whose BR-RUA-004 is indeterminate (request-state versions not dense),
 * so BR-RUA-006 makes the verdict indeterminate although every gate is verified.
 *
 * @example
 * validIndeterminateOracleResult().trial_validity; // 'valid'
 */
export function validIndeterminateOracleResult(): OracleResult {
  return {
    ...treatmentPassOracleResult(),
    preservation_verdict: 'indeterminate',
    correct_completion: null,
    ...derivedFields(TREATMENT_GATES, ONE_TRANSACTION, 'indeterminate'),
  };
}

export const ORACLE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('oracle_result', controlPassOracleResult()),
  groupCExample('oracle_result (treatment pass)', treatmentPassOracleResult()),
  groupCExample('oracle_result (indeterminate)', indeterminateOracleResult()),
  groupCExample('oracle_result (invalid treatment)', invalidTreatmentOracleResult()),
  groupCExample('oracle_result (control fail)', controlFailOracleResult()),
  groupCExample('oracle_result (valid indeterminate)', validIndeterminateOracleResult()),
];

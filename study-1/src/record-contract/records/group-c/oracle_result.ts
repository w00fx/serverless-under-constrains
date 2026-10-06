// Catalogue group C row 67 (design §6.2, §6.3): the oracle result of one trial (CTR-RUA-001
// plus the D-04 transparency fields `validity_gates`, `monetary_observations` and
// `treatment_condition_results`).

import type { EvidenceRef } from '../../evidence-refs.ts';
import type {
  DecimalString,
  GateValue,
  JsonValue,
  RuleOutcome,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
  VariantId,
} from '../../primitives.ts';
import type { ProcessingTerminalReason } from '../group-b/vocabulary.ts';
import type { ArtifactRef, SixConditionResults, TrialExecutionIdentity } from './shared-shapes.ts';
import type { ApplicableGateValue, ClockAssumptionId, GateId, OracleRuleId, TrialValidity } from './vocabulary.ts';

/** One validity gate of BR-RUA-029 (design §8.3). */
export interface ValidityGate {
  readonly gate: GateId;
  readonly value: GateValue;
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
}

/** One `rule_results[]` entry: stable id, result, structured expected and observed values. */
export interface RuleResult {
  readonly rule_id: OracleRuleId;
  readonly result: RuleOutcome;
  readonly expected: JsonValue;
  readonly observed: JsonValue;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly indeterminate_reasons: readonly StructuredReason[];
}

/** Always reported, conclusive or not (INV-RUA-001, AC-RUA-017, D-15). */
export interface MonetaryObservations {
  readonly successful_transaction_count: number;
  readonly refunded_total_minor: DecimalString;
  readonly provider_transaction_ids: readonly Uuid4[];
  readonly ledger_complete: boolean;
}

type NineGates = readonly [
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
  ValidityGate,
];
type TenRules = readonly [
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
];

/**
 * BR-RUA-030 and D-17: `correct_completion` follows the verdict, and a `pass` or `fail` always
 * has a terminal reason (either needs a valid trial, so a verified G6, which needs a terminal
 * reason), so only `pass` with `SUCCEEDED` completes correctly (AC-RUA-052).
 */
export type VerdictOutcome =
  | {
      readonly preservation_verdict: 'pass';
      readonly correct_completion: true;
      readonly processing_terminal_reason: 'SUCCEEDED';
    }
  | {
      readonly preservation_verdict: 'pass';
      readonly correct_completion: false;
      readonly processing_terminal_reason: Exclude<ProcessingTerminalReason, 'SUCCEEDED'>;
    }
  | {
      readonly preservation_verdict: 'fail';
      readonly correct_completion: false;
      readonly processing_terminal_reason: ProcessingTerminalReason;
    }
  | {
      readonly preservation_verdict: 'indeterminate';
      readonly correct_completion: null;
      readonly processing_terminal_reason: ProcessingTerminalReason | null;
    };

/** D-05: control trials carry no fidelity basis; treatment trials declare CA-1. */
export type ScenarioAssessment =
  | {
      readonly scenario: 'CONTROL';
      readonly control_integrity: Exclude<GateValue, 'not_applicable'>;
      readonly treatment_fidelity: 'not_applicable';
      readonly fidelity_basis: 'not_applicable';
      readonly clock_assumption_refs: readonly [];
      readonly treatment_condition_results: readonly [];
    }
  | {
      readonly scenario: 'COMMIT_THEN_TIMEOUT';
      readonly control_integrity: 'not_applicable';
      readonly treatment_fidelity: Exclude<GateValue, 'not_applicable'>;
      readonly fidelity_basis: 'causal_plus_cross_source_clock_assumption' | 'causal';
      readonly clock_assumption_refs: readonly ClockAssumptionId[];
      readonly treatment_condition_results: SixConditionResults;
    };

interface OracleResultFields {
  readonly schema_version: 1;
  readonly record_type: 'oracle_result';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
  readonly variant_id: VariantId;
  readonly trial_validity: TrialValidity;
  readonly validity_gates: NineGates;
  /** INV-RUA-001: identity integrity is always applicable (design §8.3 G3). */
  readonly identity_integrity: ApplicableGateValue;
  readonly rule_results: TenRules;
  readonly indeterminate_reasons: readonly StructuredReason[];
  readonly ledger_snapshot_ref: ArtifactRef;
  readonly monetary_observations: MonetaryObservations;
  readonly checked_at: UtcMillis;
}

/** A trial belongs to a run or a variant validation, never to both and never to a probe (D-06). */
export type OracleExecutionIdentity = TrialExecutionIdentity;

/** Schema: `schemas/group-c/oracle_result.schema.json`. */
export type OracleResult = OracleResultFields & OracleExecutionIdentity & VerdictOutcome & ScenarioAssessment;

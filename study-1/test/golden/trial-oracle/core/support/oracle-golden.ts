// The trial-oracle core goldens (design §14 rows AC-RUA-001 ... AC-RUA-052): a case's committed
// fixture is ingested as its subject trial's evidence, exactly as the production caller does, and
// evaluated by the oracle with a fixed `checked_at`. Before any comparison, both outputs must hold
// their contracts: the oracle result and the attempt projection validate against their schemas,
// and every concluded or indeterminate rule satisfies BR-RUA-035. The projection compared with a
// case's expectation is what the AC sentences name: verdict, validity, completion, terminal
// reason, gate values, rule outcomes, the artifacts each rule cites, the reason codes of each
// non-concluding rule and gate, the reason codes per named artifact, the monetary observations and the attempt projection's counts.
// Artifact paths are written relative to the subject trial (`$trial/...`), so one expectation
// reads the same for every base.

import { ingestEvidence } from '../../../../../src/evidence-ingestion/ingest-evidence.ts';
import { validateResultReferences } from '../../../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, StructuredReason, UtcMillis } from '../../../../../src/record-contract/primitives.ts';
import type { AttemptProjection } from '../../../../../src/record-contract/records/group-c/attempt_projection.ts';
import type { OracleResult } from '../../../../../src/record-contract/records/group-c/oracle_result.ts';
import { createRecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import { evaluateTrial } from '../../../../../src/trial-oracle/evaluate-trial.ts';
import type { TrialEvaluation } from '../../../../../src/trial-oracle/evaluate-trial.ts';
import { ingestionInputOf } from '../../../evidence-ingestion/ingestion-input.ts';
import { expectedMismatches, loadGoldenCase } from '../../../_harness/golden-harness.ts';

/** The instant every core golden is checked at: after every base's subject trial is frozen. */
export const CHECKED_AT = '2026-10-05T13:30:00.000Z' as UtcMillis;

const validator = createRecordValidator();

/** A case's evaluation, with the subject directory its artifact paths are relative to. */
export interface CoreEvaluation {
  readonly evaluation: TrialEvaluation;
  readonly subject_directory: string;
  readonly expected: JsonValue;
}

/**
 * Loads a core case, ingests its fixture and evaluates its subject trial; throws when the oracle
 * refuses the evidence, which fails the calling test.
 *
 * @example
 * const { evaluation } = await evaluateCoreCase('ac001-conventional-control');
 */
export async function evaluateCoreCase(caseId: string): Promise<CoreEvaluation> {
  const loaded = await loadGoldenCase(`test/golden/trial-oracle/core/cases/${caseId}.case.ts`);
  const evidence = ingestEvidence(ingestionInputOf(loaded), validator);
  const evaluated = evaluateTrial({ evidence, checked_at: CHECKED_AT });
  if (!evaluated.ok) {
    throw new Error(`${caseId} was refused: ${JSON.stringify(evaluated.error)}; expected an oracle result`);
  }
  return {
    evaluation: evaluated.value,
    subject_directory: loaded.subject_directory,
    expected: loaded.golden_case.expected,
  };
}

/**
 * Every contract the two outputs break: schema violations of each, and each rule result whose
 * references break BR-RUA-035. Empty for a sound evaluation.
 *
 * @example
 * contractViolations(evaluation); // []
 */
export function contractViolations(evaluation: TrialEvaluation): readonly string[] {
  const result = validator.validateAs('oracle_result', evaluation.result as unknown as JsonValue);
  const projection = validator.validateAs('attempt_projection', evaluation.projection as unknown as JsonValue);
  const references = evaluation.result.rule_results.flatMap((rule) =>
    rule.result === 'not_applicable'
      ? []
      : validateResultReferences(rule.result, rule.evidence_refs, rule.indeterminate_reasons).map(
          (violation) => `${rule.rule_id}: ${violation}`,
        ),
  );
  return [
    ...(result.valid ? [] : [`oracle_result: ${JSON.stringify(result.violations)}`]),
    ...(projection.valid ? [] : [`attempt_projection: ${JSON.stringify(projection.violations)}`]),
    ...references,
  ];
}

/**
 * Where a case's evaluation departs from its contracts and its expectation; empty when it holds.
 *
 * @example
 * assert.deepEqual(await coreMismatches('ac005-zero-tx'), []);
 */
export async function coreMismatches(caseId: string): Promise<readonly string[]> {
  const { evaluation, subject_directory: subject, expected } = await evaluateCoreCase(caseId);
  return [...contractViolations(evaluation), ...expectedMismatches(expected, comparedView(evaluation, subject))];
}

/**
 * The members of an evaluation a core case may name.
 *
 * @example
 * comparedView(evaluation, 'trials/<trial_id>').rules; // { 'BR-RUA-001': 'pass', ... }
 */
export function comparedView(evaluation: TrialEvaluation, subject: string): JsonValue {
  const { result, projection } = evaluation;
  return {
    preservation_verdict: result.preservation_verdict,
    trial_validity: result.trial_validity,
    correct_completion: result.correct_completion,
    processing_terminal_reason: result.processing_terminal_reason,
    control_integrity: result.control_integrity,
    treatment_fidelity: result.treatment_fidelity,
    identity_integrity: result.identity_integrity,
    gates: Object.fromEntries(result.validity_gates.map((gate) => [gate.gate, gate.value])),
    gate_reason_codes: Object.fromEntries(result.validity_gates.map((gate) => [gate.gate, reasonCodes(gate.reasons)])),
    rules: Object.fromEntries(result.rule_results.map((rule) => [rule.rule_id, rule.result])),
    rule_artifacts: Object.fromEntries(
      result.rule_results.map((rule) => [rule.rule_id, citedArtifacts(rule.evidence_refs, subject)]),
    ),
    rule_reason_codes: Object.fromEntries(
      result.rule_results.map((rule) => [rule.rule_id, reasonCodes(rule.indeterminate_reasons)]),
    ),
    reason_codes_by_artifact: reasonCodesByArtifact(result, subject),
    monetary_observations: {
      successful_transaction_count: result.monetary_observations.successful_transaction_count,
      refunded_total_minor: result.monetary_observations.refunded_total_minor,
      ledger_complete: result.monetary_observations.ledger_complete,
    },
    projection: projectionCounts(projection),
  };
}

function reasonCodes(reasons: readonly StructuredReason[]): readonly string[] {
  return [...new Set(reasons.map((reason) => reason.code))].toSorted();
}

function citedArtifacts(refs: readonly EvidenceRef[], subject: string): readonly string[] {
  return [...new Set(refs.map((ref) => relativeToSubject(ref.artifact_path, subject)))].toSorted();
}

// The codes of the result's indeterminate reasons, keyed by the artifact each names.
function reasonCodesByArtifact(result: OracleResult, subject: string): JsonValue {
  const codes = new Map<string, Set<string>>();
  for (const reason of result.indeterminate_reasons) {
    const path = reason.artifact_path === undefined ? '(none)' : relativeToSubject(reason.artifact_path, subject);
    codes.set(path, (codes.get(path) ?? new Set<string>()).add(reason.code));
  }
  return Object.fromEntries([...codes].map(([path, named]) => [path, [...named].toSorted()]));
}

function relativeToSubject(path: string, subject: string): string {
  return path.startsWith(`${subject}/`) ? `$trial/${path.slice(subject.length + 1)}` : path;
}

function projectionCounts(projection: AttemptProjection): JsonValue {
  return {
    attempt_count: projection.attempts.length,
    refund_request_ids: projection.attempts.map((attempt) => attempt.refund_request_id),
    outcomes: projection.attempts.map((attempt) => attempt.outcome ?? null),
    knowledge_after_recorded: projection.attempts.map((attempt) => attempt.knowledge_after_recorded ?? null),
    provider_call_count: projection.provider_calls.length,
    transaction_count: projection.transactions.length,
    durable_execution_count: projection.durable_executions.length,
  };
}

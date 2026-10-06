// The run package the AC-RUA-010 golden cases freeze (design §7, §12.4): the harness base
// `run-durable-treatment` (all four canonical trials; the subject is the fourth, Durable
// COMMIT_THEN_TIMEOUT) plus every file the base does not build. The additions are the canonical
// catalogue examples of their record types (WP-01, WP-02, WP-03), so each one is a schema-valid
// record; the evidence index judges a file by its path and exact bytes only, never by content.
//
// What the operations add, and why:
// - the execution-level core files a trial depends on (environment input, source provenance,
//   oracle revision check, deployment-assembly inventory; design §7 index scopes);
// - the subject's conditional DLQ snapshot (AC-RUA-010 "conditional DLQ snapshot") and its derived
//   attempt projection and oracle result (AC-RUA-010 "derived artifacts remain distinguishable");
// - what the index must leave out: a stale `evidence-index.json` of the subject itself, the
//   late-evidence area (BR-RUA-044), the A-09 execution-level provider journal, a readiness
//   journal (addendum §2) and the run summary, all written by later or execution-wide phases.
//   The three earlier trials of the base are the "other trials" the index excludes.
//
// The expected index rows below are written from the design §7 layout and the §6.2 catalogue kinds
// (I, M, E, O primary; D, P derived), never copied from the index builder's output.

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ArtifactClass, ArtifactDerivation } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { CANONICAL_EXAMPLES as GROUP_A } from '../../../contract/record-contract/group-a/support/canonical-examples.ts';
import { CANONICAL_EXAMPLES as GROUP_B } from '../../../contract/record-contract/group-b/examples/group-b-examples.ts';
import { CANONICAL_EXAMPLES as GROUP_C } from '../../../contract/record-contract/group-c/examples/group-c-examples.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';

/** The base every AC-RUA-010 case starts from. */
export const FROZEN_TRIAL_BASE = 'run-durable-treatment';

/** One row the evidence index of the subject trial must hold; `$trial/` names the subject directory. */
export interface ExpectedIndexRow {
  readonly artifact_path: string;
  readonly artifact_class: ArtifactClass;
  readonly derivation: ArtifactDerivation;
}

function putJson(path: string, record: JsonObject): ScenarioOperation {
  return { op: 'put_file', path, content: { kind: 'json', record } };
}

function putJsonl(path: string, records: readonly JsonObject[]): ScenarioOperation {
  return { op: 'put_file', path, content: { kind: 'jsonl', records } };
}

/**
 * The operations that complete the base into the package as it stands at the subject's freeze,
 * plus the files the index must exclude.
 *
 * @example
 * defineGoldenCase({ case_id, ac_ids: ['AC-RUA-010'], rule_outcomes_reached: [], base: FROZEN_TRIAL_BASE,
 *   operations: FROZEN_TRIAL_OPERATIONS, expected });
 */
export const FROZEN_TRIAL_OPERATIONS: readonly ScenarioOperation[] = [
  putJson('admission/environment-input.json', GROUP_A.environment_input()),
  putJson('admission/source-provenance.json', GROUP_A.source_provenance()),
  putJson('admission/oracle-revision-check.json', toJson(GROUP_C.oracle_revision_check())),
  putJson('admission/deployment-assembly.inventory.json', GROUP_A.deployment_assembly_inventory()),
  putJson('$trial/queues/dlq-snapshot.json', toJson(GROUP_B.dlq_snapshot())),
  putJson('$trial/derived/attempt-projection.json', toJson(GROUP_C.attempt_projection())),
  putJson('$trial/derived/oracle-result.json', toJson(GROUP_C.oracle_result())),
  putJson('$trial/evidence-index.json', toJson(GROUP_C.evidence_index())),
  putJsonl('late-evidence/late-evidence-stream.jsonl', [toJson(GROUP_C.late_evidence_record())]),
  putJson('late-evidence/late-evidence-assessment.json', toJson(GROUP_C.late_evidence_assessment())),
  putJsonl('provider/provider-journal.jsonl', [toJson(GROUP_B.provider_call_rejected())]),
  putJsonl('readiness/warmup-provider-journal.jsonl', [toJson(GROUP_B.provider_warmup_completed())]),
  putJson('summary/run-summary.json', toJson(GROUP_C.run_summary())),
];

function primary(artifactPath: string, artifactClass: ArtifactClass): ExpectedIndexRow {
  return { artifact_path: artifactPath, artifact_class: artifactClass, derivation: 'primary' };
}

function derived(artifactPath: string, artifactClass: ArtifactClass): ExpectedIndexRow {
  return { artifact_path: artifactPath, artifact_class: artifactClass, derivation: 'derived' };
}

/**
 * Every row of the subject's evidence index (design §7: every file under the trial directory but
 * the index itself, plus the six execution-level core files), in no particular order.
 */
export const EXPECTED_INDEX_ROWS: readonly ExpectedIndexRow[] = [
  primary('admission/deployment-assembly.inventory.json', 'deployment_assembly_inventory'),
  primary('admission/environment-input.json', 'environment_input'),
  primary('admission/execution-manifest.json', 'execution_manifest'),
  primary('admission/oracle-revision-check.json', 'oracle_revision_check'),
  primary('admission/source-provenance.json', 'source_provenance'),
  primary('provisioning/resource-manifest.json', 'resource_manifest'),
  primary('$trial/trial-manifest.json', 'trial_manifest'),
  primary('$trial/inputs/payment.json', 'payment'),
  primary('$trial/inputs/approved-decision.json', 'approved_decision'),
  primary('$trial/inputs/published-message.json', 'published_message'),
  primary('$trial/state/provider-trial-configuration.json', 'provider_trial_configuration'),
  primary('$trial/state/treatment-state-snapshot.json', 'treatment_state_snapshot'),
  primary('$trial/state/trial-registration.json', 'trial_registration'),
  primary('$trial/journals/caller-journal.jsonl', 'caller_journal'),
  primary('$trial/journals/provider-journal.jsonl', 'provider_journal'),
  primary('$trial/journals/controller-journal.jsonl', 'controller_journal'),
  primary('$trial/ledger/ledger-snapshot.json', 'ledger_snapshot'),
  primary('$trial/queues/source-observations.jsonl', 'source_observations'),
  primary('$trial/queues/dlq-observations.jsonl', 'dlq_observations'),
  primary('$trial/queues/dlq-snapshot.json', 'dlq_snapshot'),
  primary('$trial/settlement/settlement-samples.jsonl', 'settlement_samples'),
  primary('$trial/execution-metadata/durable-executions.json', 'durable_execution_metadata'),
  primary('$trial/telemetry/telemetry-availability.json', 'telemetry_availability'),
  derived('$trial/derived/attempt-projection.json', 'attempt_projection'),
  derived('$trial/derived/oracle-result.json', 'oracle_result'),
];

/** Present in the package at freeze, absent from the subject's evidence index (BR-RUA-044, design §7). */
export const EXPECTED_EXCLUSIONS: readonly string[] = [
  '$trial/evidence-index.json',
  'late-evidence/late-evidence-stream.jsonl',
  'late-evidence/late-evidence-assessment.json',
  // The third trial of the base run (conventional COMMIT_THEN_TIMEOUT): another trial.
  'trials/1549b47d-5c04-4f8c-98f1-789a4dc2eda2/ledger/ledger-snapshot.json',
  'trials/1549b47d-5c04-4f8c-98f1-789a4dc2eda2/trial-manifest.json',
  // Open across the whole execution, so the final package index hashes them (design §7).
  'runner/runner-journal.jsonl',
  'provider/provider-journal.jsonl',
  'readiness/warmup-provider-journal.jsonl',
  'summary/run-summary.json',
];

/**
 * The rows as case `expected` JSON.
 *
 * @example
 * expected: { rows: rowsAsJson(EXPECTED_INDEX_ROWS) }
 */
export function rowsAsJson(rows: readonly ExpectedIndexRow[]): JsonValue {
  return rows.map((row) => ({ ...row }));
}

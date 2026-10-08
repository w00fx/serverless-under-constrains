// The records of the golden variant-validation packages. Admission and trial records start from the
// catalogue's contract examples and are re-identified into one validation (its id, its two declared
// trials, its manifest digest). The oracle results are the contract examples of BR-RUA-029 verdict
// matrix rows, re-identified the same way: WP-14's oracle does not exist yet, so a result is an
// input of these goldens, never their expectation (evidence/WP-17/decisions.md). Their references
// are re-anchored to files the golden package really stores, so the package verifier resolves them.

import { compareEvidenceRefs } from '../../../../src/record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../../../../src/record-contract/evidence-refs.ts';
import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue, Sha256Hex, Uuid4, VariantId } from '../../../../src/record-contract/primitives.ts';
import type { RecordType } from '../../../../src/record-contract/record-types.ts';
import type { DeclaredTrial } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { SourceProvenance } from '../../../../src/record-contract/records/group-a/source_provenance.ts';
import type { TrialManifest } from '../../../../src/record-contract/records/group-a/trial_manifest.ts';
import type { OracleResult } from '../../../../src/record-contract/records/group-c/oracle_result.ts';
import type { OracleRevisionCheck } from '../../../../src/record-contract/records/group-c/oracle_revision_check.ts';
import type { RecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import type { ValidationManifest } from '../../../../src/variant-validation/validation-summary.ts';
import { sourceProvenance } from '../../../contract/record-contract/group-a/support/admission-examples.ts';
import {
  trialManifest,
  validationExecutionManifest,
} from '../../../contract/record-contract/group-a/support/manifest-examples.ts';
import {
  controlFailOracleResult,
  controlPassOracleResult,
  invalidTreatmentOracleResult,
  treatmentPassOracleResult,
  validIndeterminateOracleResult,
} from '../../../contract/record-contract/group-c/examples/oracle-examples.ts';
import { passedRevisionCheck } from '../../../contract/record-contract/group-c/examples/operator-examples.ts';
import { TRIAL_ID as EXAMPLE_TRIAL_ID, at, uuid } from '../../../support/record-contract/record-builders.ts';

export const GOLDEN_VALIDATION_ID = uuid(0x1700);
export const CONTROL_TRIAL_ID = uuid(0x1701);
export const TREATMENT_TRIAL_ID = uuid(0x1702);

/** The oracle results these goldens feed the summary with, each a verdict-matrix row. */
export type ControlResultKind = 'pass' | 'fail';
export type TreatmentResultKind = 'pass' | 'fail' | 'verdict_indeterminate' | 'fidelity_invalid';

const EXAMPLE_TRIAL_DIRECTORY = `trials/${EXAMPLE_TRIAL_ID}/`;

/**
 * The validation manifest of `variant`, before its source-provenance digest is known.
 *
 * @example
 * goldenManifest('durable', provenanceDigest).trials[1].scenario; // 'COMMIT_THEN_TIMEOUT'
 */
export function goldenManifest(variant: VariantId, provenanceDigest: Sha256Hex): ValidationManifest {
  const example = validationExecutionManifest();
  if (example.execution_kind !== 'VARIANT_VALIDATION') {
    throw new Error(`example manifest is ${example.execution_kind}; expected VARIANT_VALIDATION`);
  }
  return {
    ...example,
    variant_validation_id: GOLDEN_VALIDATION_ID,
    variant_id: variant,
    trials: [
      { sequence: 1, trial_id: CONTROL_TRIAL_ID, variant_id: variant, scenario: 'CONTROL' },
      { sequence: 2, trial_id: TREATMENT_TRIAL_ID, variant_id: variant, scenario: 'COMMIT_THEN_TIMEOUT' },
    ],
    source: { ...example.source, source_provenance_sha256: provenanceDigest },
  };
}

/**
 * The source provenance the manifest freezes (BR-RUA-042).
 *
 * @example
 * goldenProvenance().clean_confirmed; // true
 */
export function goldenProvenance(): SourceProvenance {
  return sourceProvenance();
}

/**
 * The oracle revision check of the admission: `passed`, or `failed` with its reason (D-18).
 *
 * @example
 * goldenRevisionCheck('failed').result; // 'failed'
 */
export function goldenRevisionCheck(result: 'passed' | 'failed'): OracleRevisionCheck {
  const passed = passedRevisionCheck();
  if (result === 'passed') {
    return passed;
  }
  return {
    ...passed,
    exit_code: 1,
    test_counts: { tests: 120, pass: 119, fail: 1, skipped: 0, todo: 0 },
    result: 'failed',
    reasons: [
      { code: 'GOLDEN_TEST_FAILED', subject: 'npm run test:golden', detail: '1 golden test failed; expected 0' },
    ],
  };
}

/**
 * The trial manifest of a declared trial of the golden manifest.
 *
 * @example
 * goldenTrialManifest(trial, manifestDigest, files).variant_validation_id; // GOLDEN_VALIDATION_ID
 */
export function goldenTrialManifest(
  trial: DeclaredTrial,
  manifestDigest: Sha256Hex,
  digestOf: (path: string) => Sha256Hex,
): TrialManifest {
  const { run_id: _runId, ...example } = trialManifest();
  const directory = `trials/${trial.trial_id}`;
  return {
    ...example,
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: manifestDigest,
    trial_id: trial.trial_id,
    sequence: trial.sequence,
    variant_id: trial.variant_id,
    scenario: trial.scenario,
    payment_sha256: digestOf(`${directory}/inputs/payment.json`),
    approved_decision_sha256: digestOf(`${directory}/inputs/approved-decision.json`),
  };
}

/** What an oracle result of a golden trial is re-identified with. */
export interface OracleIdentity {
  readonly trial: DeclaredTrial;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_manifest_sha256: Sha256Hex;
  /** The trial's stored files, which every reference is re-anchored to. */
  readonly files: readonly PackageFile[];
  readonly validator: RecordValidator;
}

/**
 * The control trial's oracle result: matrix row 1 (`pass`) or row 10 (`fail`, two transactions).
 *
 * @example
 * controlOracleResult('fail', identity).preservation_verdict; // 'fail'
 */
export function controlOracleResult(kind: ControlResultKind, identity: OracleIdentity): OracleResult {
  return reidentified(kind === 'pass' ? controlPassOracleResult() : controlFailOracleResult(), identity);
}

/**
 * The treatment trial's oracle result: matrix row 7 (`pass`); row 7 with the two-transaction ledger
 * of row 10 (`fail`: BR-RUA-001, -002 and -009 fail); a valid trial whose BR-RUA-004 is
 * indeterminate (`verdict_indeterminate`); or row 4 (`fidelity_invalid`: a conflicting signal).
 *
 * @example
 * treatmentOracleResult('fidelity_invalid', identity).treatment_fidelity; // 'invalid'
 */
export function treatmentOracleResult(kind: TreatmentResultKind, identity: OracleIdentity): OracleResult {
  return reidentified(TREATMENT_EXAMPLES[kind](), identity);
}

const TREATMENT_EXAMPLES: Readonly<Record<TreatmentResultKind, () => OracleResult>> = {
  pass: treatmentPassOracleResult,
  fail: treatmentFailOracleResult,
  verdict_indeterminate: validIndeterminateOracleResult,
  fidelity_invalid: invalidTreatmentOracleResult,
};

function treatmentFailOracleResult(): OracleResult {
  const pass = treatmentPassOracleResult();
  const twoTransactions = controlFailOracleResult();
  // BR-RUA-001, -002 and -009 (positions 0, 1 and 8) are the monetary rules the ledger decides.
  const monetary = new Set([0, 1, 8]);
  const rules = pass.rule_results.map((rule, position) =>
    monetary.has(position) ? (twoTransactions.rule_results[position] ?? rule) : rule,
  );
  const failed = {
    ...pass,
    preservation_verdict: 'fail',
    correct_completion: false,
    rule_results: rules,
    monetary_observations: twoTransactions.monetary_observations,
  };
  // `reidentified` checks the result against its schema, so the cast cannot hide a bad record.
  return failed as unknown as OracleResult;
}

function reidentified(example: OracleResult, identity: OracleIdentity): OracleResult {
  const { run_id: _runId, variant_validation_id: _validationId, ...rest } = example;
  const moved: JsonObject = {
    ...(rest as unknown as JsonObject),
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: identity.execution_manifest_sha256,
    trial_id: identity.trial.trial_id,
    trial_manifest_sha256: identity.trial_manifest_sha256,
    variant_id: identity.trial.variant_id,
  };
  const anchored = anchorReferences(moved, identity.trial.trial_id, identity.files);
  return validated(anchored, 'oracle_result', identity.validator) as unknown as OracleResult;
}

/**
 * `value` with every reference moved into trial `trialId` and pinned to the stored bytes: the
 * example trial directory becomes the golden one, the evidence index becomes the trial manifest
 * (the index lists the result, so the result cannot cite it), and `event_id`/`json_pointer` are
 * dropped because the golden files are placeholders. Reference lists stay sorted and unique.
 *
 * @example
 * anchorReferences(result, CONTROL_TRIAL_ID, files);
 */
export function anchorReferences(value: JsonValue, trialId: Uuid4, files: readonly PackageFile[]): JsonValue {
  if (isJsonArray(value)) {
    return value.map((item) => anchorReferences(item, trialId, files));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  if (typeof value['artifact_path'] === 'string' && typeof value['artifact_sha256'] === 'string') {
    return anchoredRef(value['artifact_path'], trialId, files) as unknown as JsonObject;
  }
  const entries = Object.entries(value).map(([key, member]): [string, JsonValue] => {
    const anchored = anchorReferences(member, trialId, files);
    return [key, key === 'evidence_refs' && isJsonArray(anchored) ? uniqueSorted(anchored) : anchored];
  });
  return Object.fromEntries(entries);
}

function anchoredRef(examplePath: string, trialId: Uuid4, files: readonly PackageFile[]): EvidenceRef {
  const relative = examplePath.startsWith(EXAMPLE_TRIAL_DIRECTORY)
    ? examplePath.slice(EXAMPLE_TRIAL_DIRECTORY.length)
    : examplePath;
  const renamed = relative === 'evidence-index.json' ? 'trial-manifest.json' : relative;
  const path = `trials/${trialId}/${renamed}`;
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`golden reference ${examplePath} maps to ${path}, which the package lacks; expected a stored file`);
  }
  return { artifact_path: path, artifact_sha256: sha256Hex(file.bytes) };
}

function uniqueSorted(refs: readonly JsonValue[]): JsonValue {
  const byKey = new Map(refs.map((ref) => [JSON.stringify(ref), ref]));
  return [...byKey.values()].toSorted((a, b) =>
    compareEvidenceRefs(a as unknown as EvidenceRef, b as unknown as EvidenceRef),
  );
}

/**
 * The record after a schema check: a golden input that is not a valid record is a fixture bug.
 *
 * @example
 * validated(json, 'oracle_result', validator);
 */
export function validated(value: JsonValue, recordType: RecordType, validator: RecordValidator): JsonValue {
  const checked = validator.validateAs(recordType, value);
  if (!checked.valid) {
    throw new Error(
      `golden ${recordType} is invalid: ${JSON.stringify(checked.violations.slice(0, 3))}; expected a valid record`,
    );
  }
  return value;
}

/**
 * A golden timestamp, offset from the shared base instant.
 *
 * @example
 * goldenAt(1); // '2026-10-05T12:00:00.001Z'
 */
export const goldenAt = at;

// One execution of the derived Study 1 results (close-out Phase 1): a run or a variant
// validation, read from its frozen package and its verify outputs. Whether a variant validation
// counts as a within-variant reproduction is decided by one criterion applied to its own summary,
// never chosen by hand: an included validation must meet it, and an excluded one must fail it,
// with the reasons its package states.

import { sha256Hex } from '../../src/record-contract/digests.ts';
import type { JsonObject } from '../../src/record-contract/primitives.ts';
import type { ArtifactRef, CitedRecord, EvidenceFileReader, EvidencePackage } from './study-results-reading.ts';
import {
  booleanOf,
  byArtifactPath,
  integerOf,
  loadPackage,
  objectOf,
  objectsOf,
  parseRecord,
  readRecord,
  stringOf,
} from './study-results-reading.ts';
import type { TrialResult } from './study-results-trial.ts';
import { citedOracleResult, deriveTrialResult } from './study-results-trial.ts';

export type ExecutionKind = 'run' | 'variant_validation';

export const REPRODUCTION_CRITERION =
  'A variant validation is a within-variant reproduction only when its summary states ' +
  'implementation_validation_status verified and validation_validity valid.';

/** One file outside the packages, by its path relative to the evidence root. */
export interface LooseFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What one execution's derivation reads. */
export interface ExecutionInput {
  readonly kind: ExecutionKind;
  readonly id: string;
  readonly read: EvidenceFileReader;
  readonly verifications: readonly LooseFile[];
}

/** One verify command's output record, cited by digest, with the outcome members it states. */
export interface VerificationResult {
  readonly path: string;
  readonly sha256: string;
  readonly record_type: string;
  readonly recorded_at: string;
  readonly outcome: Readonly<Record<string, string>>;
}

/** A safety boundary with an integer millisecond observation. */
export interface TimeBoundary {
  readonly observed_ms: number;
  readonly declared_limit_ms: number;
  readonly result: string;
}

/** The safety assessment's estimated cost, as decimal USD strings. */
export interface CostBoundary {
  readonly observed_usd: string;
  readonly declared_limit_usd: string;
  readonly result: string;
}

export interface SafetyResult {
  readonly safety_status: string;
  readonly estimated_cost: CostBoundary;
  readonly active_time: TimeBoundary;
  readonly total_time: TimeBoundary;
}

/** The members every execution entry shares: identity, source and verify outputs. */
interface ExecutionIdentity {
  readonly execution_kind: ExecutionKind;
  readonly execution_id: string;
  readonly package_directory: string;
  readonly package_index_sha256: string;
  readonly source_commit: string;
  readonly outcome: Readonly<Record<string, string>>;
  readonly closure: Readonly<Record<string, string>>;
  readonly verifications: readonly VerificationResult[];
}

/** One counted execution: the canonical run or a within-variant reproduction. */
export interface ExecutionResult extends ExecutionIdentity {
  readonly role: 'canonical_run' | 'within_variant_reproduction';
  readonly comparative: boolean;
  readonly non_comparative_basis: string | null;
  readonly selected_probe: { readonly transport_probe_id: string; readonly original_package_index_sha256: string };
  readonly safety: SafetyResult;
  readonly trials: readonly TrialResult[];
  readonly evidence_refs: readonly ArtifactRef[];
}

/** One trial of an excluded validation: its verdict and why the oracle could not conclude. */
export interface ExcludedTrial {
  readonly trial_id: string;
  readonly sequence: number;
  readonly scenario: string;
  readonly variant_id: string;
  readonly preservation_verdict: string;
  readonly trial_validity: string;
  readonly unverified_gates: readonly string[];
  readonly indeterminate_reason_codes: readonly string[];
  readonly evidence_refs: readonly ArtifactRef[];
}

/** A variant validation that fails the reproduction criterion, with the reasons it states. */
export interface ExcludedExecution extends ExecutionIdentity {
  readonly role: 'excluded';
  readonly comparative: false;
  readonly exclusion: {
    readonly criterion: string;
    readonly status_reasons: readonly Readonly<Record<string, string>>[];
  };
  readonly trials: readonly ExcludedTrial[];
  readonly evidence_refs: readonly ArtifactRef[];
}

interface KindShape {
  readonly folder: string;
  readonly summaryPath: string;
  readonly summaryType: string;
  readonly idMember: string;
  readonly outcomeMembers: readonly string[];
}

interface OpenedExecution {
  readonly pkg: EvidencePackage;
  readonly summary: CitedRecord;
  readonly provenance: CitedRecord;
  readonly subject: string;
  readonly identity: ExecutionIdentity;
}

const KIND_SHAPES: Readonly<Record<ExecutionKind, KindShape>> = {
  run: {
    folder: 'runs',
    summaryPath: 'summary/run-summary.json',
    summaryType: 'run_summary',
    idMember: 'run_id',
    outcomeMembers: ['run_terminal_reason', 'execution_status', 'comparison_eligibility'],
  },
  variant_validation: {
    folder: 'variant-validations',
    summaryPath: 'summary/validation-summary.json',
    summaryType: 'validation_summary',
    idMember: 'variant_validation_id',
    outcomeMembers: ['validation_terminal_reason', 'implementation_validation_status', 'validation_validity'],
  },
};

const CLOSURE_MEMBERS = [
  'cleanup_status',
  'leak_audit_status',
  'lease_status',
  'safety_status',
  'evidence_integrity_status',
] as const;

// The member that times each verify output and the members that state its outcome, per record type.
const VERIFICATION_SHAPES: Readonly<Record<string, { readonly time: string; readonly outcome: readonly string[] }>> = {
  package_verification: { time: 'evaluated_at', outcome: ['package_eligibility'] },
  study_completion_assessment: {
    time: 'assessed_at',
    outcome: ['study_completion', 'comparison_eligibility', 'package_eligibility'],
  },
  variant_validation_verification: {
    time: 'checked_at',
    outcome: ['effective_implementation_validation_status', 'validation_validity', 'package_eligibility'],
  },
};

// Gate values that leave a trial conclusive; any other value is why a verdict is indeterminate.
const CONCLUSIVE_GATE_VALUES: readonly string[] = ['verified', 'not_applicable'];

const MANIFEST = 'admission/execution-manifest.json';
const PROVENANCE = 'admission/source-provenance.json';
const SAFETY = 'summary/safety-assessment.json';

/**
 * One counted execution's derived result. A variant validation must meet the reproduction
 * criterion.
 *
 * @example
 * deriveExecutionResult({ kind: 'run', id, read, verifications }, limitation9).outcome.comparison_eligibility; // 'eligible'
 */
export function deriveExecutionResult(input: ExecutionInput, limitation9: string): ExecutionResult {
  const { pkg, summary, provenance, subject, identity } = openExecution(input);
  const validation = input.kind === 'variant_validation';
  if (validation && !isReproduction(summary.record, subject)) {
    throw new Error(`${subject}: ${criterionValues(summary.record, subject)}; expected verified and valid to count it`);
  }
  const manifest = readRecord(pkg, MANIFEST);
  const safety = readRecord(pkg, SAFETY);
  return {
    execution_kind: identity.execution_kind,
    execution_id: identity.execution_id,
    role: validation ? 'within_variant_reproduction' : 'canonical_run',
    comparative: !validation,
    non_comparative_basis: validation ? `Spec limitation 9: ${limitation9}` : null,
    package_directory: identity.package_directory,
    package_index_sha256: identity.package_index_sha256,
    source_commit: identity.source_commit,
    selected_probe: selectedProbeOf(manifest.record, `${pkg.directory}/${MANIFEST}`),
    outcome: identity.outcome,
    closure: identity.closure,
    safety: safetyResult(safety.record, `${pkg.directory}/${SAFETY}`),
    verifications: identity.verifications,
    trials: objectsOf(summary.record, 'trial_results', subject).map((entry) => agreedTrial(pkg, entry)),
    evidence_refs: [manifest.ref, provenance.ref, summary.ref, safety.ref].sort(byArtifactPath),
  };
}

/**
 * One excluded variant validation, refused unless its summary fails the reproduction criterion.
 *
 * @example
 * deriveExcludedExecution({ kind: 'variant_validation', id, read, verifications }).outcome.validation_validity; // 'indeterminate'
 */
export function deriveExcludedExecution(input: ExecutionInput): ExcludedExecution {
  const { pkg, summary, provenance, subject, identity } = openExecution({ ...input, kind: 'variant_validation' });
  if (isReproduction(summary.record, subject)) {
    throw new Error(`${subject}: ${criterionValues(summary.record, subject)}; expected a validation that fails it`);
  }
  const statusReasons = objectsOf(summary.record, 'status_reasons', subject).map((reason) =>
    membersOf(reason, ['code', 'subject', 'detail'], subject),
  );
  const { execution_kind, execution_id, ...described } = identity;
  return {
    execution_kind,
    execution_id,
    role: 'excluded',
    comparative: false,
    ...described,
    exclusion: { criterion: REPRODUCTION_CRITERION, status_reasons: statusReasons },
    trials: objectsOf(summary.record, 'trial_results', subject).map((entry) => excludedTrial(pkg, entry)),
    evidence_refs: [provenance.ref, summary.ref].sort(byArtifactPath),
  };
}

function openExecution(input: ExecutionInput): OpenedExecution {
  const shape = KIND_SHAPES[input.kind];
  const pkg = loadPackage(`${shape.folder}/${input.id}`, input.read);
  const summary = readRecord(pkg, shape.summaryPath);
  const subject = `${pkg.directory}/${shape.summaryPath}`;
  assertSummaryNames(summary.record, shape, input.id, subject);
  const provenance = readRecord(pkg, PROVENANCE);
  const identity: ExecutionIdentity = {
    execution_kind: input.kind,
    execution_id: input.id,
    package_directory: pkg.directory,
    package_index_sha256: pkg.index_sha256,
    source_commit: stringOf(provenance.record, 'commit_sha', `${pkg.directory}/${PROVENANCE}`),
    outcome: membersOf(summary.record, shape.outcomeMembers, subject),
    closure: membersOf(summary.record, CLOSURE_MEMBERS, subject),
    verifications: input.verifications.map((file) => verificationResult(file, pkg)),
  };
  return { pkg, summary, provenance, subject, identity };
}

function isReproduction(summary: JsonObject, subject: string): boolean {
  return (
    stringOf(summary, 'implementation_validation_status', subject) === 'verified' &&
    stringOf(summary, 'validation_validity', subject) === 'valid'
  );
}

function criterionValues(summary: JsonObject, subject: string): string {
  const status = stringOf(summary, 'implementation_validation_status', subject);
  const validity = stringOf(summary, 'validation_validity', subject);
  return `implementation_validation_status is ${status} and validation_validity is ${validity}`;
}

function excludedTrial(pkg: EvidencePackage, entry: JsonObject): ExcludedTrial {
  const oracle = citedOracleResult(pkg, entry);
  const trialId = stringOf(entry, 'trial_id', `${pkg.directory} summary trial`);
  const manifest = readRecord(pkg, `trials/${trialId}/trial-manifest.json`);
  const subject = `${pkg.directory}/${oracle.ref.artifact_path}`;
  const unverifiedGates = objectsOf(oracle.record, 'validity_gates', subject)
    .filter((gate) => !CONCLUSIVE_GATE_VALUES.includes(stringOf(gate, 'value', subject)))
    .map((gate) => `${stringOf(gate, 'gate', subject)}=${stringOf(gate, 'value', subject)}`);
  const reasonCodes = objectsOf(oracle.record, 'indeterminate_reasons', subject).map((reason) =>
    stringOf(reason, 'code', subject),
  );
  return {
    trial_id: trialId,
    sequence: integerOf(entry, 'sequence', `${pkg.directory} summary trial ${trialId}`),
    scenario: stringOf(manifest.record, 'scenario', `${pkg.directory}/${manifest.ref.artifact_path}`),
    variant_id: stringOf(manifest.record, 'variant_id', `${pkg.directory}/${manifest.ref.artifact_path}`),
    preservation_verdict: stringOf(oracle.record, 'preservation_verdict', subject),
    trial_validity: stringOf(oracle.record, 'trial_validity', subject),
    unverified_gates: unverifiedGates,
    indeterminate_reason_codes: [...new Set(reasonCodes)].sort(),
    evidence_refs: [manifest.ref, oracle.ref].sort(byArtifactPath),
  };
}

function assertSummaryNames(summary: JsonObject, shape: KindShape, id: string, subject: string): void {
  const recordType = stringOf(summary, 'record_type', subject);
  const named = stringOf(summary, shape.idMember, subject);
  if (recordType !== shape.summaryType || named !== id) {
    throw new Error(`${subject} is a ${recordType} of ${named}; expected the ${shape.summaryType} of ${id}`);
  }
}

function selectedProbeOf(
  manifest: JsonObject,
  subject: string,
): { transport_probe_id: string; original_package_index_sha256: string } {
  const qualification = objectOf(manifest, 'qualification', subject);
  return {
    transport_probe_id: stringOf(qualification, 'transport_probe_id', `${subject} qualification`),
    original_package_index_sha256: stringOf(qualification, 'original_package_index_sha256', `${subject} qualification`),
  };
}

function membersOf(record: JsonObject, names: readonly string[], subject: string): Readonly<Record<string, string>> {
  return Object.fromEntries(names.map((name) => [name, stringOf(record, name, subject)]));
}

/**
 * The single element of `found`, refused with `refusal` when there are none or several.
 *
 * @example
 * exactlyOne(checks.filter(isCost), 'expected exactly one ESTIMATED_COST check');
 */
export function exactlyOne<T>(found: readonly T[], refusal: string): T {
  const [only, ...rest] = found;
  if (only === undefined || rest.length > 0) {
    throw new Error(refusal);
  }
  return only;
}

function safetyResult(assessment: JsonObject, subject: string): SafetyResult {
  const checks = objectsOf(assessment, 'checks', subject);
  const boundary = (name: string): JsonObject => {
    const found = checks.filter((check) => stringOf(check, 'boundary', subject) === name);
    return exactlyOne(found, `${subject} holds ${String(found.length)} ${name} checks; expected exactly one`);
  };
  const cost = boundary('ESTIMATED_COST');
  return {
    safety_status: stringOf(assessment, 'safety_status', subject),
    estimated_cost: {
      observed_usd: quantityOf(cost, 'observed', USD, subject),
      declared_limit_usd: quantityOf(cost, 'declared_limit', USD, subject),
      result: stringOf(cost, 'result', subject),
    },
    active_time: timeBoundary(boundary('ACTIVE_TIME'), subject),
    total_time: timeBoundary(boundary('TOTAL_TIME'), subject),
  };
}

const USD = /^(\d+\.\d{2}) USD$/;
const MILLISECONDS = /^(\d+) ms$/;

function timeBoundary(check: JsonObject, subject: string): TimeBoundary {
  return {
    observed_ms: Number(quantityOf(check, 'observed', MILLISECONDS, subject)),
    declared_limit_ms: Number(quantityOf(check, 'declared_limit', MILLISECONDS, subject)),
    result: stringOf(check, 'result', subject),
  };
}

function quantityOf(check: JsonObject, name: string, unit: RegExp, subject: string): string {
  const value = stringOf(check, name, subject);
  const quantity = unit.exec(value)?.[1];
  if (quantity === undefined) {
    throw new Error(`${subject}: ${name} is ${JSON.stringify(value)}; expected a quantity matching ${String(unit)}`);
  }
  return quantity;
}

function verificationResult(file: LooseFile, pkg: EvidencePackage): VerificationResult {
  const record = parseRecord(file.bytes, file.path);
  const recordType = stringOf(record, 'record_type', file.path);
  const shape = VERIFICATION_SHAPES[recordType];
  if (shape === undefined) {
    throw new Error(`${file.path} is a ${recordType}; expected one of ${Object.keys(VERIFICATION_SHAPES).join(', ')}`);
  }
  const verified = stringOf(record, 'original_package_index_sha256', file.path);
  if (verified !== pkg.index_sha256) {
    throw new Error(`${file.path} verifies package ${verified}; expected ${pkg.directory} at ${pkg.index_sha256}`);
  }
  return {
    path: file.path,
    sha256: sha256Hex(file.bytes),
    record_type: recordType,
    recorded_at: stringOf(record, shape.time, file.path),
    outcome: membersOf(record, shape.outcome, file.path),
  };
}

// The summary states each trial's verdict too: it must agree with the one derived from the oracle.
function agreedTrial(pkg: EvidencePackage, entry: JsonObject): TrialResult {
  const trial = deriveTrialResult(pkg, entry);
  const subject = `${pkg.directory} summary trial ${trial.trial_id}`;
  const stated = [
    stringOf(entry, 'scenario', subject),
    stringOf(entry, 'variant_id', subject),
    stringOf(entry, 'preservation_verdict', subject),
    String(booleanOf(entry, 'correct_completion', subject)),
  ].join(' ');
  const derived = [trial.scenario, trial.variant_id, trial.preservation_verdict, String(trial.correct_completion)].join(
    ' ',
  );
  if (stated !== derived) {
    throw new Error(`${subject} states "${stated}"; expected the trial's derived "${derived}"`);
  }
  return trial;
}

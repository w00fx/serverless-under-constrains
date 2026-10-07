// The derived Study 1 results file (close-out Phase 1): the canonical run and the variant
// validations, read from their frozen evidence packages. Every value comes from a package artifact
// or a verification record, and every artifact is cited with its digest. A variant validation is
// labeled a within-variant reproduction and never comparative, with spec limitation 9 quoted from
// the spec itself. The raw packages stay the authority; this file is a derived view of them.

import { sha256Hex } from '../../src/record-contract/digests.ts';
import type { JsonObject } from '../../src/record-contract/primitives.ts';
import type { ArtifactRef, EvidenceFileReader, EvidencePackage } from './study-results-reading.ts';
import {
  booleanOf,
  byArtifactPath,
  loadPackage,
  objectOf,
  objectsOf,
  parseRecord,
  readRecord,
  stringOf,
} from './study-results-reading.ts';
import type { TrialResult } from './study-results-trial.ts';
import { deriveTrialResult } from './study-results-trial.ts';

export type ExecutionKind = 'run' | 'variant_validation';

/** One file outside the packages, by its path relative to the evidence root. */
export interface LooseFile {
  readonly path: string;
  readonly bytes: Uint8Array;
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

/** One execution (run or variant validation) of the derived results. */
export interface ExecutionResult {
  readonly execution_kind: ExecutionKind;
  readonly execution_id: string;
  readonly role: 'canonical_run' | 'within_variant_reproduction';
  readonly comparative: boolean;
  readonly non_comparative_basis: string | null;
  readonly package_directory: string;
  readonly package_index_sha256: string;
  readonly source_commit: string;
  readonly selected_probe: { readonly transport_probe_id: string; readonly original_package_index_sha256: string };
  readonly outcome: Readonly<Record<string, string>>;
  readonly closure: Readonly<Record<string, string>>;
  readonly safety: SafetyResult;
  readonly verifications: readonly VerificationResult[];
  readonly trials: readonly TrialResult[];
  readonly evidence_refs: readonly ArtifactRef[];
}

/** The whole derived results file. */
export interface StudyResults {
  readonly record_type: 'study_results';
  readonly schema_version: 1;
  readonly capability: 'CAP-RUA';
  readonly derived_by: string;
  readonly authority: string;
  readonly field_definitions: Readonly<Record<string, string>>;
  readonly canonical_runs: readonly ExecutionResult[];
  readonly within_variant_reproductions: readonly ExecutionResult[];
}

/** What one execution's derivation reads. */
export interface ExecutionInput {
  readonly kind: ExecutionKind;
  readonly id: string;
  readonly read: EvidenceFileReader;
  readonly verifications: readonly LooseFile[];
}

/** The parsed command line of tools/derive-study-results.ts. */
export interface DeriveArguments {
  readonly evidenceRoot: string;
  readonly spec: string;
  readonly runs: readonly string[];
  readonly validations: readonly string[];
  readonly out: string;
  readonly check: boolean;
}

interface KindShape {
  readonly folder: string;
  readonly summaryPath: string;
  readonly summaryType: string;
  readonly idMember: string;
  readonly outcomeMembers: readonly string[];
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

const MANIFEST = 'admission/execution-manifest.json';
const PROVENANCE = 'admission/source-provenance.json';
const SAFETY = 'summary/safety-assessment.json';
const LIMITATIONS_HEADING = '## Threats to Validity and Limitations';
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE =
  'node tools/derive-study-results.ts --evidence-root <dir> --spec <spec.md> --run <id> ' +
  '[--validation <id> ...] --out <results.json> [--check]';

export const FIELD_DEFINITIONS: Readonly<Record<string, string>> = {
  paths:
    'Every artifact path is relative to its package directory; package and verification paths are relative to the evidence root.',
  package_index_sha256: "SHA-256 of the package's package-index.json bytes: the package's identity.",
  'safety.estimated_cost': "The safety assessment's pre-billing cost estimate (BR-RUA-046), not billed cost.",
  'safety.active_time': "The safety assessment's observed active time against its declared limit.",
  'trials[].preservation_verdict': "The frozen oracle result's verdict on the single-refund invariant.",
  'trials[].successful_transaction_count':
    'SUCCEEDED transactions in the frozen ledger snapshot, cross-checked with the oracle.',
  'trials[].refunded_total_minor': 'Sum of amount_minor over those transactions, in minor units of currency.',
  'trials[].commit_gap_seconds':
    'Seconds from the first to the second commit_requested_at; null with fewer than two commits.',
  'trials[].retry.source_receive_count': 'Highest approximate_receive_count over the caller journal invocations.',
  'trials[].retry.durable_step_attempt':
    'Highest step_attempt over the caller journal invocations; null for a conventional caller.',
  'trials[].retry.durable_executions':
    'Each Durable execution: its status, last history event and highest step attempt.',
  'trials[].retry.mechanism':
    'source_redelivery when receive count > 1; durable_step_retry when step attempt > 1; both or none.',
  within_variant_reproductions: 'Variant validations: one variant each, never comparative (spec limitation 9).',
};

/**
 * The derived results of the given executions, in the order given.
 *
 * @example
 * deriveStudyResults([runInput, ...validationInputs], limitationOf(specText, 9)).canonical_runs[0].trials.length; // 4
 */
export function deriveStudyResults(inputs: readonly ExecutionInput[], limitation9: string): StudyResults {
  const executions = inputs.map((input) => deriveExecutionResult(input, limitation9));
  return {
    record_type: 'study_results',
    schema_version: 1,
    capability: 'CAP-RUA',
    derived_by: 'study-1/tools/derive-study-results.ts',
    authority: "Each package's package-index.json digest is the authority; this file is a derived view.",
    field_definitions: FIELD_DEFINITIONS,
    canonical_runs: executions.filter((one) => one.execution_kind === 'run'),
    within_variant_reproductions: executions.filter((one) => one.execution_kind === 'variant_validation'),
  };
}

/**
 * One execution's derived result, read from its package and its verify outputs.
 *
 * @example
 * deriveExecutionResult({ kind: 'run', id, read, verifications }, limitation9).outcome.comparison_eligibility; // 'eligible'
 */
export function deriveExecutionResult(input: ExecutionInput, limitation9: string): ExecutionResult {
  const shape = KIND_SHAPES[input.kind];
  const pkg = loadPackage(`${shape.folder}/${input.id}`, input.read);
  const summary = readRecord(pkg, shape.summaryPath);
  const summarySubject = `${pkg.directory}/${shape.summaryPath}`;
  assertSummaryNames(summary.record, shape, input.id, summarySubject);
  const manifest = readRecord(pkg, MANIFEST);
  const provenance = readRecord(pkg, PROVENANCE);
  const safety = readRecord(pkg, SAFETY);
  const validation = input.kind === 'variant_validation';
  return {
    execution_kind: input.kind,
    execution_id: input.id,
    role: validation ? 'within_variant_reproduction' : 'canonical_run',
    comparative: !validation,
    non_comparative_basis: validation ? `Spec limitation 9: ${limitation9}` : null,
    package_directory: pkg.directory,
    package_index_sha256: pkg.index_sha256,
    source_commit: stringOf(provenance.record, 'commit_sha', `${pkg.directory}/${PROVENANCE}`),
    selected_probe: selectedProbeOf(manifest.record, `${pkg.directory}/${MANIFEST}`),
    outcome: membersOf(summary.record, shape.outcomeMembers, summarySubject),
    closure: membersOf(summary.record, CLOSURE_MEMBERS, summarySubject),
    safety: safetyResult(safety.record, `${pkg.directory}/${SAFETY}`),
    verifications: input.verifications.map((file) => verificationResult(file, pkg)),
    trials: objectsOf(summary.record, 'trial_results', summarySubject).map((entry) => agreedTrial(pkg, entry)),
    evidence_refs: [manifest.ref, provenance.ref, summary.ref, safety.ref].sort(byArtifactPath),
  };
}

/**
 * The text of numbered limitation `number` in the spec's limitations section.
 *
 * @example
 * limitationOf(specText, 9); // 'Variant-validation evidence is non-comparative and cannot substitute for …'
 */
export function limitationOf(specMarkdown: string, number: number): string {
  const section = specMarkdown.split(`\n${LIMITATIONS_HEADING}\n`)[1]?.split('\n## ')[0] ?? '';
  const prefix = `${String(number)}. `;
  const line = section.split('\n').find((one) => one.startsWith(prefix));
  if (line === undefined) {
    throw new Error(
      `the spec holds no limitation ${String(number)} under "${LIMITATIONS_HEADING}"; expected a line "${prefix}…"`,
    );
  }
  return line.slice(prefix.length);
}

/**
 * The derived results as the committed file holds them: two-space JSON with a trailing newline.
 *
 * @example
 * writeFileSync(out, serializeStudyResults(results));
 */
export function serializeStudyResults(results: StudyResults): string {
  return `${JSON.stringify(results, null, 2)}\n`;
}

/**
 * The command line of tools/derive-study-results.ts, refused with the usage when malformed.
 *
 * @example
 * parseDeriveArguments(['--evidence-root', 'evidence', '--spec', 's.md', '--run', id, '--out', 'r.json']).check; // false
 */
export function parseDeriveArguments(argv: readonly string[]): DeriveArguments {
  const values = new Map<string, string[]>();
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!isValueFlag(flag) || value === undefined || value.startsWith('--')) {
      throw new Error(`usage: ${USAGE}; got ${JSON.stringify(argv)}`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const single = (flag: string): string => {
    const found = values.get(flag) ?? [];
    return exactlyOne(found, `usage: ${USAGE}; got ${JSON.stringify(argv)} with ${String(found.length)} ${flag}`);
  };
  const runs = values.get('--run') ?? [];
  const validations = values.get('--validation') ?? [];
  const malformed = [...runs, ...validations].filter((id) => !EXECUTION_ID.test(id));
  if (runs.length === 0 || malformed.length > 0) {
    throw new Error(`usage: ${USAGE}; got ${JSON.stringify(argv)}; expected at least one --run and lowercase UUID ids`);
  }
  return {
    evidenceRoot: single('--evidence-root'),
    spec: single('--spec'),
    runs,
    validations,
    out: single('--out'),
    check,
  };
}

function exactlyOne<T>(found: readonly T[], refusal: string): T {
  const [only, ...rest] = found;
  if (only === undefined || rest.length > 0) {
    throw new Error(refusal);
  }
  return only;
}

function isValueFlag(flag: string | undefined): flag is string {
  return (
    flag === '--evidence-root' || flag === '--spec' || flag === '--run' || flag === '--validation' || flag === '--out'
  );
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

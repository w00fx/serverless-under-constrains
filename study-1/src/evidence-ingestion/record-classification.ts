// Design §8.2 step I2: every parsed document and JSONL line is validated against the record type
// its artifact demands (BR-RUA-033). A record whose only faults are absent correlation members
// (execution identity, execution manifest digest, trial identity), or a record of the evaluated
// trial's directory without a trial identity, is CORRELATION_MISSING (BR-RUA-008, AC-RUA-041 case
// 1): traceability becomes unverified instead of invalid. Every other fault is
// RECORD_SCHEMA_INVALID. Findings are aggregated per artifact (Owner amendment A-12).

import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../record-contract/primitives.ts';
import { isEventRecordType } from '../record-contract/record-types.ts';
import type { RecordValidation, RecordValidator, SchemaViolation } from '../record-contract/schema-registry.ts';
import { ANY_EVENT, expectedRecordShape, isUnitFile } from './artifact-roles.ts';
import type { ExpectedRecordShape } from './artifact-roles.ts';
import type { ParsedArtifact, ParsedValue } from './artifact-reading.ts';
import { aggregatedDetail, ingestionFinding } from './ingestion-findings.ts';
import type {
  EvidenceScope,
  IngestedArtifact,
  IngestedRecord,
  IngestionFinding,
  RecordValidity,
} from './ingestion-model.ts';
import { DIGEST_BOUND_INPUT_TYPES, executionIdField, hasExecutionId, ownString } from './record-correlation.ts';

export interface RecordClassification {
  readonly artifacts: readonly IngestedArtifact[];
  readonly findings: readonly IngestionFinding[];
}

/** Well-formed stand-ins for absent correlation members; only their shape matters. */
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const PLACEHOLDER_SHA256 = '0'.repeat(64);
/** How many schema violations the first occurrence of an aggregated finding quotes. */
const QUOTED_VIOLATIONS = 3;

interface ValueOutcome {
  readonly validity: RecordValidity;
  /** Violations for a schema-invalid record, absent member names for missing correlation. */
  readonly problems: readonly string[];
}

interface Judge {
  readonly shape: ExpectedRecordShape | undefined;
  readonly trialUnit: boolean;
  readonly scope: EvidenceScope;
  readonly validator: RecordValidator;
}

/**
 * Validates every record of every parsed artifact and classifies it as valid, schema-invalid or
 * correlation-missing. Total: validation never throws, whatever the JSON.
 *
 * @example
 * const { artifacts, findings } = classifyRecords(parsed, scope, createRecordValidator());
 */
export function classifyRecords(
  parsed: readonly ParsedArtifact[],
  scope: EvidenceScope,
  validator: RecordValidator,
): RecordClassification {
  const classified = parsed.map((artifact) => classifyArtifact(artifact, scope, validator));
  return {
    artifacts: classified.map((entry) => entry.artifact),
    findings: classified.flatMap((entry) => entry.findings),
  };
}

function classifyArtifact(
  artifact: ParsedArtifact,
  scope: EvidenceScope,
  validator: RecordValidator,
): { readonly artifact: IngestedArtifact; readonly findings: readonly IngestionFinding[] } {
  const judge: Judge = {
    shape: expectedRecordShape(artifact),
    trialUnit: scope.subject_kind === 'trial' && isUnitFile(artifact),
    scope,
    validator,
  };
  const outcomes = artifact.values.map((parsed) => ({ parsed, outcome: classifyValue(parsed.value, judge) }));
  const records: IngestedRecord[] = outcomes.map(({ parsed, outcome }) => ({
    artifact_path: artifact.path,
    ...lineOf(parsed),
    value: parsed.value,
    validity: outcome.validity,
  }));
  const ingested: IngestedArtifact = {
    path: artifact.path,
    sha256: artifact.sha256,
    byte_length: artifact.byte_length,
    origin: artifact.origin,
    ...(artifact.artifact_class === undefined ? {} : { artifact_class: artifact.artifact_class }),
    ...(artifact.requirement === undefined ? {} : { requirement: artifact.requirement }),
    parse_status: artifact.parse_status,
    records,
  };
  const invalid = outcomes.filter(({ outcome }) => outcome.validity === 'schema_invalid');
  const uncorrelated = outcomes.filter(({ outcome }) => outcome.validity === 'correlation_missing');
  const expectation = judge.shape === ANY_EVENT ? 'journal event' : (judge.shape ?? 'catalogued');
  return {
    artifact: ingested,
    findings: [
      ...aggregate('RECORD_SCHEMA_INVALID', artifact.path, invalid, `expected a valid ${expectation} record`),
      ...aggregate(
        'CORRELATION_MISSING',
        artifact.path,
        uncorrelated,
        'expected execution and trial correlation members',
      ),
    ],
  };
}

function lineOf(parsed: ParsedValue): { readonly line_number?: number } {
  return parsed.line_number === undefined ? {} : { line_number: parsed.line_number };
}

function classifyValue(value: JsonValue, judge: Judge): ValueOutcome {
  const checked = checkShape(value, judge);
  if (checked.valid) {
    return lacksTrialIdentity(value, judge)
      ? { validity: 'correlation_missing', problems: ['trial_id absent'] }
      : { validity: 'valid', problems: [] };
  }
  if (isJsonObject(value)) {
    const absent = absentCorrelation(value, judge);
    if (absent.length > 0 && someFillValidates(value, absent, judge)) {
      const names = absent.flatMap((unit) => Object.keys(unit));
      return { validity: 'correlation_missing', problems: [`${names.join(', ')} absent`] };
    }
  }
  return { validity: 'schema_invalid', problems: checked.violations.map(describeViolation) };
}

function checkShape(value: JsonValue, judge: Judge): RecordValidation {
  if (judge.shape === undefined) {
    return judge.validator.validate(value);
  }
  if (judge.shape !== ANY_EVENT) {
    return judge.validator.validateAs(judge.shape, value);
  }
  const checked = judge.validator.validate(value);
  if (!checked.valid || isEventRecordType(checked.record.record_type)) {
    return checked;
  }
  const detail = `record_type ${boundedJsonText(checked.record.record_type)} is not a journal event; expected an event record type`;
  return { valid: false, violations: [{ instance_path: '/record_type', keyword: 'record_type', detail }] };
}

// Payment and approved decision carry no correlation member: the trial manifest binds them by
// digest (design §8.2 I3), so their lack of a trial identity is their contract, not a fault.
function lacksTrialIdentity(value: JsonValue, judge: Judge): boolean {
  if (!judge.trialUnit) {
    return false;
  }
  return !DIGEST_BOUND_INPUT_TYPES.has(ownString(value, 'record_type')) && ownString(value, 'trial_id') === undefined;
}

// Each absent correlation unit, as the members that would fill it. The trial pair is one unit:
// the schemas require both members or neither.
function absentCorrelation(value: JsonObject, judge: Judge): readonly JsonObject[] {
  const execution = judge.scope.execution;
  const executionField = execution === undefined ? 'run_id' : executionIdField(execution);
  const units: JsonObject[] = [];
  if (!hasExecutionId(value)) {
    units.push({ [executionField]: PLACEHOLDER_UUID });
  }
  if (!Object.hasOwn(value, 'execution_manifest_sha256')) {
    units.push({ execution_manifest_sha256: PLACEHOLDER_SHA256 });
  }
  const trialFill = judge.trialUnit ? absentTrialMembers(value) : {};
  if (Object.keys(trialFill).length > 0) {
    units.push(trialFill);
  }
  return units;
}

function absentTrialMembers(value: JsonObject): JsonObject {
  return {
    ...(Object.hasOwn(value, 'trial_id') ? {} : { trial_id: PLACEHOLDER_UUID }),
    ...(Object.hasOwn(value, 'trial_manifest_sha256') ? {} : { trial_manifest_sha256: PLACEHOLDER_SHA256 }),
  };
}

// A record is correlation-missing when filling some of its absent correlation units makes it
// valid: not every record type carries every unit (the published message has no execution
// manifest digest), so every non-empty combination is tried (at most seven).
function someFillValidates(value: JsonObject, absent: readonly JsonObject[], judge: Judge): boolean {
  const combinations = 2 ** absent.length;
  for (let mask = 1; mask < combinations; mask += 1) {
    const fill = absent.filter((_, index) => (mask & (2 ** index)) !== 0);
    if (checkShape(withMembers(value, fill), judge).valid) {
      return true;
    }
  }
  return false;
}

// Spread defines own data properties, so a parsed own `__proto__` member stays a member the
// closed root refuses (A-07). `Object.assign` would run the `__proto__` setter instead: the member
// would vanish into the prototype and a record carrying it could pass as correlation-missing
// (A-05, review finding WP-12 R1).
function withMembers(value: JsonObject, units: readonly JsonObject[]): JsonObject {
  return units.reduce<JsonObject>((filled, unit) => ({ ...filled, ...unit }), { ...value });
}

function describeViolation(violation: SchemaViolation): string {
  return `${violation.instance_path === '' ? '/' : violation.instance_path} ${violation.keyword}: ${violation.detail}`;
}

function aggregate(
  code: 'RECORD_SCHEMA_INVALID' | 'CORRELATION_MISSING',
  path: string,
  entries: readonly { readonly parsed: ParsedValue; readonly outcome: ValueOutcome }[],
  expectation: string,
): readonly IngestionFinding[] {
  const [first] = entries;
  if (first === undefined) {
    return [];
  }
  const where = first.parsed.line_number === undefined ? 'document' : `line ${String(first.parsed.line_number)}`;
  const problems = first.outcome.problems.slice(0, QUOTED_VIOLATIONS).join('; ');
  // The expectation leads: the first occurrence is cut to a bounded length, and only the problems may be lost.
  const detail = aggregatedDetail(`${expectation}; ${where}: ${problems}`, entries.length);
  return [ingestionFinding(code, detail, { artifact_path: path, occurrences: entries.length })];
}

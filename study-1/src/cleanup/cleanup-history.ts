// Reads what earlier cleanup runs recorded in `cleanup/cleanup-journal.jsonl` (AC-RUA-011: "a
// re-run skips steps the cleanup journal shows as succeeded"). The bytes are untrusted input:
// any byte sequence yields a history and never a throw (Owner amendment A-05).
//
// A line is accepted only when it is a schema-valid `cleanup_action_recorded` of this execution
// and manifest whose resource action matches its ownership basis. Every other line is skipped
// with a finding. Skipping is the safe direction: a step whose `succeeded` line is unreadable
// simply runs again, and every step is idempotent, while trusting a malformed line could skip a
// deletion that never happened.

import { boundedText } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { JsonlLine } from '../record-contract/parsing.ts';
import { parseJsonl } from '../record-contract/parsing.ts';
import type { CleanupActionRecorded } from '../record-contract/records/group-b/cleanup_action_recorded.ts';
import type { OwnershipBasis } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResourceAction } from '../record-contract/records/group-c/vocabulary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { CleanupActionEntry } from './cleanup-action-fold.ts';
import { isResourceAction } from './cleanup-action-fold.ts';

/** Findings kept per history read; the rest are counted in one closing finding. */
export const MAX_HISTORY_FINDINGS = 20;
const JOURNAL_SUBJECT = 'cleanup-journal.jsonl';

export interface HistoryExpectation {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
}

export interface CleanupHistory {
  /** Accepted actions in file order, oldest first. */
  readonly entries: readonly CleanupActionEntry[];
  /** Why lines were skipped, at most MAX_HISTORY_FINDINGS + 1. */
  readonly findings: readonly StructuredReason[];
}

type LineVerdict =
  { readonly ok: true; readonly entry: CleanupActionEntry } | { readonly ok: false; readonly detail: string };

const IDENTITY_KEYS = ['run_id', 'variant_validation_id', 'transport_probe_id'] as const;
type IdentityFields = Readonly<Partial<Record<(typeof IDENTITY_KEYS)[number], string>>>;

// What step 9 may record for each resource action (cleanup_result `cleanup_resource` rules).
const BASES_BY_ACTION: Readonly<Record<CleanupResourceAction, readonly OwnershipBasis[]>> = {
  SKIPPED_AMBIGUOUS: ['ambiguous'],
  EXCLUDED_BASELINE: ['excluded_baseline'],
  DELETED: ['recorded_stack', 'resource_manifest_and_tags', 'tags_name_type_created_after_freeze'],
  ALREADY_ABSENT: ['recorded_stack', 'resource_manifest_and_tags', 'tags_name_type_created_after_freeze'],
  DELETE_FAILED: ['recorded_stack', 'resource_manifest_and_tags', 'tags_name_type_created_after_freeze'],
};

/**
 * Reads earlier cleanup actions from the cleanup journal bytes; total over any input.
 *
 * @example
 * const history = readCleanupHistory(bytes, { execution, execution_manifest_sha256 }, validator);
 * history.entries.length; // the actions earlier runs recorded
 */
export function readCleanupHistory(
  bytes: Uint8Array,
  expected: HistoryExpectation,
  validator: RecordValidator,
): CleanupHistory {
  const entries: CleanupActionEntry[] = [];
  const skipped: StructuredReason[] = [];
  for (const line of parseJsonl(bytes).lines) {
    const verdict = judgeLine(line, expected, validator);
    if (verdict.ok) {
      entries.push(verdict.entry);
      continue;
    }
    skipped.push({
      code: 'CLEANUP_HISTORY_LINE_SKIPPED',
      subject: JOURNAL_SUBJECT,
      detail: `line ${String(line.line_number)}: ${verdict.detail}; expected a valid cleanup_action_recorded of this execution, so its step runs again`,
    });
  }
  return { entries, findings: capFindings(skipped) };
}

function judgeLine(line: JsonlLine, expected: HistoryExpectation, validator: RecordValidator): LineVerdict {
  if (!line.parsed.ok) {
    const failure = line.parsed.error;
    const detail =
      failure.kind === 'invalid_json' ? failure.detail : `invalid UTF-8 at byte ${String(failure.byte_offset)}`;
    return { ok: false, detail: `unparsable (${boundedText(detail)})` };
  }
  const validation = validator.validateAs('cleanup_action_recorded', line.parsed.value);
  if (!validation.valid) {
    const where = validation.violations
      .slice(0, 1)
      .map((violation) => `${boundedText(violation.instance_path)} fails ${violation.keyword}: ${violation.detail}`)
      .join('');
    return { ok: false, detail: `invalid record (${where})` };
  }
  return judgeRecord(validation.record as CleanupActionRecorded, expected);
}

function judgeRecord(record: CleanupActionRecorded, expected: HistoryExpectation): LineVerdict {
  const recorded = identityText(record);
  const wanted = identityText(executionIdentityFields(expected.execution));
  if (recorded !== wanted || record.execution_manifest_sha256 !== expected.execution_manifest_sha256) {
    return {
      ok: false,
      detail: `recorded for ${recorded} with manifest ${record.execution_manifest_sha256} instead of ${wanted} with manifest ${expected.execution_manifest_sha256}`,
    };
  }
  const basisMismatch = resourceBasisMismatch(record);
  if (basisMismatch !== undefined) {
    return { ok: false, detail: basisMismatch };
  }
  return { ok: true, entry: { body: bodyOf(record), occurred_at: record.occurred_at } };
}

function resourceBasisMismatch(record: CleanupActionRecorded): string | undefined {
  if (!isResourceAction(record.action)) {
    return undefined;
  }
  const allowed = BASES_BY_ACTION[record.action];
  const basis = record.ownership_basis;
  if (basis !== undefined && allowed.includes(basis)) {
    return undefined;
  }
  return `action ${record.action} with ownership_basis ${basis ?? 'absent'}; expected one of ${allowed.join(', ')}`;
}

// The identity fields a record names, as text: exactly one for a schema-valid record.
function identityText(fields: IdentityFields): string {
  return IDENTITY_KEYS.flatMap((key) => {
    const value = fields[key];
    return value === undefined ? [] : [`${key} ${value}`];
  }).join(', ');
}

// The record-specific fields, listed one by one so no envelope field reaches the fold.
function bodyOf(record: CleanupActionRecorded): CleanupActionEntry['body'] {
  return {
    step: record.step,
    step_status: record.step_status,
    cleanup_mode: record.cleanup_mode,
    cleanup_induced: record.cleanup_induced,
    action: record.action,
    ...(record.resource_type === undefined ? {} : { resource_type: record.resource_type }),
    ...(record.resource_identifier === undefined ? {} : { resource_identifier: record.resource_identifier }),
    ...(record.ownership_basis === undefined ? {} : { ownership_basis: record.ownership_basis }),
    reasons: record.reasons,
  };
}

function capFindings(findings: readonly StructuredReason[]): readonly StructuredReason[] {
  if (findings.length <= MAX_HISTORY_FINDINGS) {
    return findings;
  }
  const omitted = findings.length - MAX_HISTORY_FINDINGS;
  return [
    ...findings.slice(0, MAX_HISTORY_FINDINGS),
    {
      code: 'CLEANUP_HISTORY_FINDINGS_OMITTED',
      subject: JOURNAL_SUBJECT,
      detail: `${String(omitted)} further skipped lines are not listed; expected at most ${String(MAX_HISTORY_FINDINGS)} findings per read`,
    },
  ];
}

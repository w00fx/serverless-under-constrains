// One admission step's verdict and the records it becomes (BR-RUA-039, design §10.1): each step
// appends one `preflight_check_recorded`, and the first failing step also becomes the attempt's
// `admission_rejection`. A step states what it checked (`subject`), the declared limit or expected
// value, what it observed when it could, and on failure its rejection class and reasons.
// Expected and observed values are values admission builds itself (strings, safe integers,
// booleans), never raw untrusted JSON, so they always satisfy the record's check-value rules.

import type { StructuredReason, UtcMillis, Uuid4, ExecutionKind } from '../record-contract/primitives.ts';
import type {
  AdmissionCheckId,
  AdmissionRejection,
  AdmissionRejectionClass,
} from '../record-contract/records/group-a/admission_rejection.ts';
import type {
  CheckValue,
  PreflightCheckRecorded,
} from '../record-contract/records/group-a/preflight_check_recorded.ts';

/** What one step checked. */
export interface CheckStatement {
  readonly subject: string;
  readonly expected: CheckValue;
  readonly observed?: CheckValue;
}

export type StepVerdict<T> =
  | { readonly passed: true; readonly value: T; readonly statement: CheckStatement }
  | {
      readonly passed: false;
      readonly statement: CheckStatement;
      readonly rejection_class: AdmissionRejectionClass;
      readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
    };

/**
 * A passing step.
 *
 * @example
 * passed(identity, { subject: 'caller_account', expected: '012345678901', observed: '012345678901' });
 */
export function passed<T>(value: T, statement: CheckStatement): StepVerdict<T> {
  return { passed: true, value, statement };
}

/**
 * A failing step with at least one reason.
 *
 * @example
 * failed('ACCOUNT', { subject: 'caller_account', expected: '012345678901' }, [reason]);
 */
export function failed<T>(
  rejectionClass: AdmissionRejectionClass,
  statement: CheckStatement,
  reasons: readonly [StructuredReason, ...StructuredReason[]],
): StepVerdict<T> {
  return { passed: false, statement, rejection_class: rejectionClass, reasons };
}

/**
 * A failing step over a list a dependency guarantees nonempty but types as a plain array;
 * `whenEmpty` keeps the rejection's reasons nonempty even if that guarantee ever broke.
 *
 * @example
 * failedWithAll('SAFETY', statement, inventory.error, admissionReason('ASSEMBLY_NOT_INVENTORIED', …));
 */
export function failedWithAll<T>(
  rejectionClass: AdmissionRejectionClass,
  statement: CheckStatement,
  reasons: readonly StructuredReason[],
  whenEmpty: StructuredReason,
): StepVerdict<T> {
  const [first = whenEmpty, ...rest] = reasons;
  return failed(rejectionClass, statement, [first, ...rest]);
}

/**
 * Fails with the given reasons when there is at least one, else passes with `value`.
 *
 * @example
 * verdictOf('FINANCIAL_INPUT', statement, validateFinancialInput(p, d), undefined);
 */
export function verdictOf<T>(
  rejectionClass: AdmissionRejectionClass,
  statement: CheckStatement,
  reasons: readonly StructuredReason[],
  value: T,
): StepVerdict<T> {
  const [first, ...rest] = reasons;
  return first === undefined ? passed(value, statement) : failed(rejectionClass, statement, [first, ...rest]);
}

export interface PreflightRecordContext {
  readonly admission_attempt_id: Uuid4;
  readonly sequence: number;
  readonly check_id: AdmissionCheckId;
  readonly checked_at: UtcMillis;
}

/**
 * The journal line of one step.
 *
 * @example
 * preflightRecord({ admission_attempt_id, sequence: 1, check_id: 'A2', checked_at }, verdict).result; // 'passed'
 */
export function preflightRecord(
  context: PreflightRecordContext,
  verdict: StepVerdict<unknown>,
): PreflightCheckRecorded {
  const shared = {
    schema_version: 1 as const,
    record_type: 'preflight_check_recorded' as const,
    admission_attempt_id: context.admission_attempt_id,
    sequence: context.sequence,
    check_id: context.check_id,
    subject: verdict.statement.subject,
    expected: verdict.statement.expected,
    ...(verdict.statement.observed === undefined ? {} : { observed: verdict.statement.observed }),
    evidence_refs: [],
    checked_at: context.checked_at,
  };
  if (verdict.passed) {
    return { ...shared, result: 'passed', reasons: [] };
  }
  return { ...shared, result: 'failed', rejection_class: verdict.rejection_class, reasons: verdict.reasons };
}

/**
 * The structured rejection of the first failing step.
 *
 * @example
 * rejectionRecord(attemptId, 'RUN', 'A3', verdict, at).rejection_class; // 'FINANCIAL_INPUT'
 */
export function rejectionRecord(
  admissionAttemptId: Uuid4,
  kind: ExecutionKind,
  checkId: AdmissionCheckId,
  verdict: Extract<StepVerdict<unknown>, { readonly passed: false }>,
  rejectedAt: UtcMillis,
): AdmissionRejection {
  return {
    schema_version: 1,
    record_type: 'admission_rejection',
    admission_attempt_id: admissionAttemptId,
    execution_kind: kind,
    rejection_class: verdict.rejection_class,
    failed_check_id: checkId,
    reasons: verdict.reasons,
    rejected_at: rejectedAt,
  };
}

// `admission_rejection` (BR-RUA-039): the structured rejection written by the first failing
// read-only admission check. A rejected attempt has no execution identity and no manifest.

import type { ExecutionKind, StructuredReason, UtcMillis, Uuid4 } from '../../primitives.ts';

/** The rejected input classes of AC-RUA-014, one per class of admission failure. */
export const ADMISSION_REJECTION_CLASSES = [
  'FINANCIAL_INPUT',
  'IDENTITY',
  'SOURCE_PROVENANCE',
  'ACCOUNT',
  'REGION',
  'SAFETY',
  'QUALIFICATION',
  'COORDINATION_CONFIGURATION',
] as const;
export type AdmissionRejectionClass = (typeof ADMISSION_REJECTION_CLASSES)[number];

/** The read-only admission steps of design §10.1, in execution order. */
export const ADMISSION_CHECK_IDS = [
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'A12',
  'A13',
  'A14',
  'A15',
] as const;
export type AdmissionCheckId = (typeof ADMISSION_CHECK_IDS)[number];

export interface AdmissionRejection {
  readonly schema_version: 1;
  readonly record_type: 'admission_rejection';
  readonly admission_attempt_id: Uuid4;
  readonly execution_kind: ExecutionKind;
  readonly rejection_class: AdmissionRejectionClass;
  readonly failed_check_id: AdmissionCheckId;
  /** At least one reason; each names the offending value and the expected shape. */
  readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
  readonly rejected_at: UtcMillis;
}

// The closed vocabulary of reasons a transport-scope snapshot cannot be computed (BR-RUA-028).
// Admission records them as qualification rejections before the manifest freezes; each
// detail names the offending value and the expected shape.

import type { StructuredReason } from '../../record-contract/primitives.ts';

/** Every scope reason is about the qualification binding. */
export const SCOPE_REASON_SUBJECT = 'BR-RUA-028';

export const SCOPE_VIOLATION_CODES = [
  'SCOPE_POLICY_UNREADABLE',
  'SCOPE_POLICY_INVALID',
  'SCOPE_POLICY_DUPLICATE_PROJECTION',
  'LOCKFILE_UNREADABLE',
  'LOCKFILE_INVALID',
  'BUNDLE_RESOLUTION_FAILED',
  'BUNDLE_MISSING_ENTRY_POINT',
  'BUNDLE_INPUT_OUTSIDE_PROJECT',
  'SOURCE_ROOT_EMPTY',
  'SCOPED_SOURCE_NOT_COMMITTED',
  'SOURCE_READ_FAILED',
  'DEPENDENCY_NOT_LOCKED',
  'BUNDLED_PACKAGE_NOT_PRODUCTION',
  'TEMPLATE_INVALID',
  'TEMPLATE_WITHOUT_PATH_METADATA',
  'PROJECTION_SELECTS_NOTHING',
  'RUNTIME_PROPERTY_MISSING',
  'RUNTIME_PROPERTY_INVALID',
  'TIMING_VALUE_INVALID',
] as const;
export type ScopeViolationCode = (typeof SCOPE_VIOLATION_CODES)[number];

/**
 * Builds one scope violation reason.
 *
 * @example
 * scopeViolation('SOURCE_ROOT_EMPTY', 'source root "src/x" holds no committed file; expected at least one');
 */
export function scopeViolation(code: ScopeViolationCode, detail: string): StructuredReason {
  return { code, subject: SCOPE_REASON_SUBJECT, detail };
}

// `preflight_check_recorded` (BR-RUA-039, BR-RUA-046, BR-RUA-055): one line of an admission
// attempt's preflight journal. It records the boundary checked, the declared limit or expected
// value, the observed value when available, the result, evidence and check time.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { StructuredReason, UtcMillis, Uuid4 } from '../../primitives.ts';
import type { AdmissionCheckId, AdmissionRejectionClass } from './admission_rejection.ts';

export const PREFLIGHT_CHECK_RESULTS = ['passed', 'failed'] as const;
export type PreflightCheckResult = (typeof PREFLIGHT_CHECK_RESULTS)[number];

/**
 * The deepest nesting of arrays and objects a check value may have; the outermost container is
 * level 1. The schema unrolls its check value to this many levels instead of referring to
 * itself, so the record validator rejects a deeper value (even 100,000 levels) instead of
 * throwing RangeError (Owner amendments A-02, A-05). Admission records scalars and shallow
 * objects, so the bound never binds a real check.
 */
export const PREFLIGHT_VALUE_MAX_DEPTH = 8;

/**
 * A declared limit or observed value as record JSON (BR-RUA-033): never null at any depth, every
 * object member name is snake_case, and containers nest at most `PREFLIGHT_VALUE_MAX_DEPTH`
 * levels (the schema checks the names and the depth).
 */
export type CheckValue = string | number | boolean | readonly CheckValue[] | { readonly [member: string]: CheckValue };

interface PreflightCheckFields {
  readonly schema_version: 1;
  readonly record_type: 'preflight_check_recorded';
  readonly admission_attempt_id: Uuid4;
  /** Dense from 1 within the admission attempt. */
  readonly sequence: number;
  readonly check_id: AdmissionCheckId;
  /** The boundary or input the step checked, for example `estimated_attributable_cost`. */
  readonly subject: string;
  /** The declared limit or expected value. */
  readonly expected: CheckValue;
  /** Omitted when the value could not be observed. */
  readonly observed?: CheckValue;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly checked_at: UtcMillis;
}

export type PreflightCheckRecorded =
  | (PreflightCheckFields & { readonly result: 'passed'; readonly reasons: readonly [] })
  | (PreflightCheckFields & {
      readonly result: 'failed';
      readonly rejection_class: AdmissionRejectionClass;
      readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
    });

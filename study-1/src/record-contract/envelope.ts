// The journal event envelope (BR-RUA-033 "Every primary event contains"). The JSON Schema
// `$defs/event_envelope` enforces the same fields; the checks here are the ones a schema
// cannot express (sorted causation) plus the identity helpers writers need.

import type { EventRecordType } from './record-types.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4, UtcMillis } from './primitives.ts';

export const EVENT_SOURCES = [
  'conventional_caller',
  'durable_caller',
  'probe_caller',
  'refund_provider',
  'treatment_controller',
  'runner',
  'coordination_lease',
  'cleanup',
  'evidence_collector',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface EventEnvelope<T extends EventRecordType> {
  readonly schema_version: 1;
  readonly record_type: T;
  readonly event_id: Uuid4;
  /** Exactly one of the three execution identities is present. */
  readonly run_id?: Uuid4;
  readonly variant_validation_id?: Uuid4;
  readonly transport_probe_id?: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  /** Both trial fields are present, or neither. */
  readonly trial_id?: Uuid4;
  readonly trial_manifest_sha256?: Sha256Hex;
  readonly occurred_at: UtcMillis;
  readonly source: EventSource;
  readonly source_instance_id: Uuid4;
  /** Dense per (source, source_instance_id), starting at 1. */
  readonly source_sequence: number;
  /** Omitted for causal roots; otherwise sorted, unique and non-empty. */
  readonly causation_event_ids?: readonly Uuid4[];
}

export type ExecutionIdentityFields =
  { readonly run_id: Uuid4 } | { readonly transport_probe_id: Uuid4 } | { readonly variant_validation_id: Uuid4 };

/**
 * Projects an execution identity onto the single envelope field that carries it.
 *
 * @example
 * executionIdentityFields({ execution_kind: 'RUN', run_id }); // { run_id }
 */
export function executionIdentityFields(identity: ExecutionIdentity): ExecutionIdentityFields {
  switch (identity.execution_kind) {
    case 'RUN':
      return { run_id: identity.run_id };
    case 'TRANSPORT_PROBE':
      return { transport_probe_id: identity.transport_probe_id };
    case 'VARIANT_VALIDATION':
      return { variant_validation_id: identity.variant_validation_id };
  }
}

/**
 * Normalizes immediate causal predecessors for serialization: `undefined` for a causal root,
 * otherwise the unique ids in lexicographic order (BR-RUA-033).
 *
 * @example
 * causationIds([callerEventId, commitEventId]); // sorted pair
 * causationIds([]); // undefined, so the property is omitted
 */
export function causationIds(ids: readonly Uuid4[]): readonly Uuid4[] | undefined {
  if (ids.length === 0) {
    return undefined;
  }
  return [...new Set(ids)].sort();
}

/**
 * Tells whether a causation list is in its serialized form: non-empty, strictly increasing
 * (so sorted and duplicate-free).
 *
 * @example
 * isCanonicalCausation(['a', 'b']); // true
 * isCanonicalCausation(['b', 'a']); // false
 */
export function isCanonicalCausation(ids: readonly string[]): boolean {
  let previous: string | undefined;
  for (const id of ids) {
    if (previous !== undefined && previous >= id) {
      return false;
    }
    previous = id;
  }
  return previous !== undefined;
}

// Catalogue group C row 76 (design §6.2, §6.3, §8.18, §9.14): the leak audit over every
// discovery surface (BR-RUA-051), with a `capability_class` per leak (D-30, BR-RUA-052).

import type { Sha256Hex, StructuredReason, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped } from './shared-shapes.ts';
import type { LeakAuditStatus, LeakAuditSurface, LeakCapabilityClass, OwnedBasis } from './vocabulary.ts';

/** One surface query of one pass; `observed` lists the run-owned identifiers it still saw. */
export interface SurfaceObservation {
  readonly surface: LeakAuditSurface;
  readonly query_ok: boolean;
  readonly observed: readonly string[];
}

/** One complete pass over every applicable surface. */
export interface AuditPass {
  readonly started_at: UtcMillis;
  readonly completed_at: UtcMillis;
  readonly surfaces: readonly SurfaceObservation[];
}

/** An owned resource still observed after cleanup. */
export interface LeakedResource {
  readonly resource_type: string;
  readonly identifier: string;
  readonly surface: LeakAuditSurface;
  readonly capability_class: LeakCapabilityClass;
  readonly ownership_basis: OwnedBasis;
}

/** A resource whose ownership could not be proven; never deleted, always reported. */
export interface AmbiguousResource {
  readonly resource_type: string;
  readonly identifier: string;
  readonly surface: LeakAuditSurface;
  readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
}

interface LeakAuditResultFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'leak_audit_result';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly leak_audit_status: LeakAuditStatus;
  readonly passes: readonly AuditPass[];
  readonly leaks: readonly LeakedResource[];
  readonly ambiguous: readonly AmbiguousResource[];
  readonly stable_absence_interval_ms: number;
  readonly audited_at: UtcMillis;
}

/** Schema: `schemas/group-c/leak_audit_result.schema.json`. */
export type LeakAuditResult = ExecutionCorrelation & LeakAuditResultFields;

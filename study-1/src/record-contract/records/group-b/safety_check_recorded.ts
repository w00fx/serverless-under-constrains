// Catalogue group B row 54 (design §6.2, §8.17): one safety check (BR-RUA-046).

import type { EventEnvelope } from '../../envelope.ts';
import type { EvidenceRef } from '../../evidence-refs.ts';
import type { UtcMillis } from '../../primitives.ts';
import type { SafetyBoundary, SafetyResult } from './vocabulary.ts';

/**
 * Schema: `schemas/group-b/safety_check_recorded.schema.json`. `within_limits` and `breached`
 * state the observed value; `unverified` may lack it.
 */
export interface SafetyCheckRecorded extends EventEnvelope<'safety_check_recorded'> {
  readonly source: 'runner';
  readonly boundary: SafetyBoundary;
  readonly declared_limit: string;
  readonly observed?: string;
  readonly result: SafetyResult;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly checked_at: UtcMillis;
}

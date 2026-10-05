// Catalogue group B row 51 (design §6.2): the settlement observer summary (BR-RUA-032, D-32).

import type { EventEnvelope } from '../../envelope.ts';
import type { StructuredReason, UtcMillis } from '../../primitives.ts';
import type { SettlementRestartCause } from './vocabulary.ts';

/** One restart of the stabilization window. */
export interface SettlementRestartRecord {
  readonly at: UtcMillis;
  readonly cause: SettlementRestartCause;
}

interface SettlementAssessedBase extends EventEnvelope<'settlement_assessed'> {
  readonly source: 'runner';
  readonly restarts: readonly SettlementRestartRecord[];
  readonly sample_count: number;
}

/** A quiet window of the stabilization interval followed by a quiet pre-freeze recheck. */
export interface EstablishedSettlement extends SettlementAssessedBase {
  readonly status: 'established';
  readonly window_start: UtcMillis;
  readonly established_at: UtcMillis;
  readonly rechecked_at: UtcMillis;
  readonly reasons: readonly [];
}

/** Settlement was not established by the observation deadline. */
export interface NotEstablishedSettlement extends SettlementAssessedBase {
  readonly status: 'not_established';
  readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
}

/** Schema: `schemas/group-b/settlement_assessed.schema.json`. */
export type SettlementAssessed = EstablishedSettlement | NotEstablishedSettlement;

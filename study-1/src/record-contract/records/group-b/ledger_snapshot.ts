// Catalogue group B row 60 (design §6.2): the independent, strongly consistent, paginated
// ledger read, never truncated (BR-RUA-005, BR-RUA-032, BR-RUA-034, BR-RUA-009).

import type { EventSource } from '../../envelope.ts';
import type { Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from './shared-shapes.ts';
import type { LedgerTransactionStatus } from './vocabulary.ts';

/** One page of the paginated Query, with the cursors that bound it. */
export interface LedgerPage {
  readonly page_number: number;
  readonly item_count: number;
  readonly start_cursor?: string;
  /** Absent on the last page; a present cursor on the last page means pagination is incomplete. */
  readonly next_cursor?: string;
}

/** One immutable ledger item, sharing provider_commit_id with its commit event (BR-RUA-025). */
export interface LedgerTransaction {
  readonly provider_transaction_id: Uuid4;
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: LedgerTransactionStatus;
  readonly commit_requested_at: UtcMillis;
}

interface LedgerSnapshotFields {
  readonly schema_version: 1;
  readonly record_type: 'ledger_snapshot';
  /** Declared writer; G1 accepts only `evidence_collector`. */
  readonly writer: EventSource;
  readonly partition_key: string;
  /** Declared read consistency; G1 accepts only `true`. */
  readonly consistent_read: boolean;
  readonly captured_at: UtcMillis;
  readonly complete: boolean;
  readonly pages: readonly LedgerPage[];
  readonly transactions: readonly LedgerTransaction[];
}

/** Schema: `schemas/group-b/ledger_snapshot.schema.json`. The probe ledger carries no trial identity. */
export type LedgerSnapshot = ExecutionCorrelation & LedgerSnapshotFields & (TrialScoped | ExecutionScoped);

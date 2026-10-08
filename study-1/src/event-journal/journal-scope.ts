// Where a journal event belongs: its execution, its partition, and the item key that orders it
// (design §9.3). Table partitions are `<execution_id>#<trial_id>` for trials,
// `<execution_id>#probe` for the transport probe, `<execution_id>#canary` for the controller
// readiness canary (D-10), `<execution_id>#warmup` for the provider warm-up (addendum §2) and
// `<execution_id>#provider` for the provider calls that name no configured trial (Owner
// amendment A-09, human decision: AC-RUA-042 journals every rejected call).
// The `execution` partition names the execution-level file journals (runner, coordination,
// provisioning, cleanup), which have no table partition. Its key `<execution_id>#execution` is
// a WP-05 addition, not part of design §9.3: the writer orders file-journal events by item key
// too, but no journal table holds items under it.
//
// The sort key `<source>#<source_instance_id>#<source_sequence:12>` keeps one instance's events
// contiguous and in sequence order under a byte-wise sort-key query.

import type { ItemKey } from '../durable-store/item-store-port.ts';
import type { EventSource } from '../record-contract/envelope.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';

export type JournalPartition =
  | { readonly kind: 'trial'; readonly trial_id: Uuid4; readonly trial_manifest_sha256: Sha256Hex }
  | { readonly kind: 'probe' }
  | { readonly kind: 'canary' }
  | { readonly kind: 'warmup' }
  | { readonly kind: 'provider' }
  | { readonly kind: 'execution' };

/** The identity every event of one writer carries (BR-RUA-033 "execution identity and manifest digest"). */
export interface JournalScope {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly partition: JournalPartition;
}

/** Digits of the zero-padded sequence in a sort key. */
export const SEQUENCE_DIGITS = 12;
/** The largest sequence a 12-digit sort key can order correctly. */
export const MAX_SOURCE_SEQUENCE = 999_999_999_999;

/**
 * The execution id of an identity: its run, transport-probe or variant-validation id.
 *
 * @example
 * executionIdOf({ execution_kind: 'RUN', run_id }); // run_id
 */
export function executionIdOf(identity: ExecutionIdentity): Uuid4 {
  switch (identity.execution_kind) {
    case 'RUN':
      return identity.run_id;
    case 'TRANSPORT_PROBE':
      return identity.transport_probe_id;
    case 'VARIANT_VALIDATION':
      return identity.variant_validation_id;
  }
}

/**
 * The table partition key of a scope (design §9.3).
 *
 * @example
 * journalPartitionKey({ execution, execution_manifest_sha256, partition: { kind: 'canary' } }); // '<run_id>#canary'
 */
export function journalPartitionKey(scope: JournalScope): string {
  const suffix = scope.partition.kind === 'trial' ? scope.partition.trial_id : scope.partition.kind;
  return `${executionIdOf(scope.execution)}#${suffix}`;
}

/**
 * Whether `sequence` is a valid `source_sequence`: an integer from 1 to `MAX_SOURCE_SEQUENCE`.
 *
 * @example
 * isSourceSequence(1); // true
 * isSourceSequence(0); // false
 */
export function isSourceSequence(sequence: number): boolean {
  return Number.isInteger(sequence) && sequence >= 1 && sequence <= MAX_SOURCE_SEQUENCE;
}

/**
 * Throws a RangeError, naming `subject` (the event type or key being built), when `sequence`
 * is not a valid `source_sequence`. The one range check of the module, so every caller reports
 * the same expected shape.
 *
 * @example
 * assertSourceSequence(0, 'dispatch_started'); // RangeError: source_sequence 0 of dispatch_started; expected an integer from 1 to 999999999999
 */
export function assertSourceSequence(sequence: number, subject: string): void {
  if (!isSourceSequence(sequence)) {
    throw new RangeError(
      `source_sequence ${String(sequence)} of ${subject}; expected an integer from 1 to ${String(MAX_SOURCE_SEQUENCE)}`,
    );
  }
}

/**
 * The item key of one journal event. Throws a RangeError for a sequence outside
 * `1..MAX_SOURCE_SEQUENCE`, because such a key would break sort order or density.
 *
 * @example
 * journalItemKey(scope, 'refund_provider', instanceId, 1).sk; // 'refund_provider#<instanceId>#000000000001'
 */
export function journalItemKey(scope: JournalScope, source: EventSource, instance: Uuid4, sequence: number): ItemKey {
  assertSourceSequence(sequence, `the item key of ${source}`);
  const paddedSequence = String(sequence).padStart(SEQUENCE_DIGITS, '0');
  return { pk: journalPartitionKey(scope), sk: `${source}#${instance}#${paddedSequence}` };
}

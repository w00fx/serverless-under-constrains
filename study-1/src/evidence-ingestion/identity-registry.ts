// Design §8.2 step I8 (INV-RUA-001): the physical identities are unique within the complete
// execution scope. Each identity has origin events, the records that create it, and appearances,
// the records that carry it afterwards. An identity collides when two origin events create it,
// when it appears in two partitions (two trials, or a trial and the execution level), or, for a
// `provider_request_id`, when it is paired with two attempts. Caller-generated collisions
// (`attempt_id`, `provider_request_id`) feed identity integrity; provider-generated ones (call,
// transaction and commit ids) feed evidence integrity. A subject record that references an
// attempt nobody registered is missing identity evidence. Collisions found only among earlier
// trials were judged with those trials and are not repeated here.

import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { sortEvidenceRefs } from '../record-contract/evidence-refs.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { LedgerSnapshot } from '../record-contract/records/group-b/ledger_snapshot.ts';
import type {
  IdentityCollision,
  IdentityKind,
  IdentityRegistry,
  IndexedEvent,
  IngestedArtifact,
  LocatedRecord,
} from './ingestion-model.ts';
import { locateRecord } from './located-records.ts';
import { ownString, partitionOf } from './record-correlation.ts';

interface IdentityOccurrence {
  readonly kind: IdentityKind;
  readonly id: string;
  /** Present when the record creates the identity. */
  readonly origin_event_id?: string;
  readonly partition: string;
  /** The attempt a `provider_request_id` is paired with. */
  readonly paired_attempt?: string;
  /** The ledger transaction that carries the identity, for a ledger occurrence. */
  readonly ledger_item?: string;
  readonly examined: boolean;
  readonly ref: EvidenceRef;
}

const CALLER_KINDS: readonly IdentityKind[] = ['attempt_id', 'provider_request_id'];
const COMMIT_KINDS: readonly IdentityKind[] = ['provider_transaction_id', 'provider_commit_id'];
const CALL_KINDS: readonly IdentityKind[] = ['provider_call_id'];

/** Event types that create identities, and which. */
const ORIGIN_KINDS: ReadonlyMap<string, readonly IdentityKind[]> = new Map([
  ['attempt_registered', CALLER_KINDS],
  ['provider_call_received', CALL_KINDS],
  ['provider_warmup_completed', CALL_KINDS],
  ['provider_call_rejected', CALL_KINDS],
  ['provider_transaction_committed', COMMIT_KINDS],
  ['provider_commit_failed', COMMIT_KINDS],
]);

/** Event types that carry identities created elsewhere, and which. */
const APPEARANCE_KINDS: ReadonlyMap<string, readonly IdentityKind[]> = new Map([
  ['dispatch_started', CALLER_KINDS],
  ['attempt_not_dispatched', CALLER_KINDS],
  ['attempt_outcome_recorded', CALLER_KINDS],
  ['transport_settled_after_timeout', CALLER_KINDS],
  ['provider_call_accepted', [...CALLER_KINDS, ...CALL_KINDS]],
  ['provider_transaction_committed', [...CALLER_KINDS, ...CALL_KINDS]],
  ['provider_commit_failed', CALL_KINDS],
]);

/** Every identity a ledger transaction carries. */
const LEDGER_KINDS: readonly IdentityKind[] = [...CALLER_KINDS, ...CALL_KINDS, ...COMMIT_KINDS];

/** The record types whose `attempt_id` must name a registered attempt. */
const ATTEMPT_REFERENCES: ReadonlySet<string> = new Set([
  'dispatch_started',
  'attempt_not_dispatched',
  'attempt_outcome_recorded',
  'caller_timeout_recorded',
  'transport_settled_after_timeout',
  'provider_call_accepted',
  'provider_transaction_committed',
]);

/**
 * Builds the identity registry over the indexed events and the ledger snapshots of the subject
 * and of earlier trials, and judges it for the subject.
 *
 * @example
 * const registry = buildIdentityRegistry([...collapse.by_id.values()], ingestedArtifacts);
 * registry.caller_collisions.length; // 0 when no caller-generated id is reused
 */
export function buildIdentityRegistry(
  events: readonly IndexedEvent[],
  artifacts: readonly IngestedArtifact[],
): IdentityRegistry {
  const occurrences = [...events.flatMap(eventOccurrences), ...ledgerSnapshots(artifacts).flatMap(ledgerOccurrences)];
  const byIdentity = new Map<string, IdentityOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.kind}#${occurrence.id}`;
    const group = byIdentity.get(key) ?? [];
    group.push(occurrence);
    byIdentity.set(key, group);
  }
  const collisions = [...byIdentity.values()].filter(isJudgedCollision).map(toCollision);
  return {
    caller_collisions: collisions.filter((collision) => CALLER_KINDS.includes(collision.kind)),
    provider_collisions: collisions.filter((collision) => !CALLER_KINDS.includes(collision.kind)),
    unregistered_attempts: unregisteredAttempts(events, byIdentity),
  };
}

function eventOccurrences(event: IndexedEvent): readonly IdentityOccurrence[] {
  const recordType = event.record.record_type;
  const origin = createsIdentities(event) ? (ORIGIN_KINDS.get(recordType) ?? []) : [];
  const appearance = (APPEARANCE_KINDS.get(recordType) ?? []).filter((kind) => !origin.includes(kind));
  const ref: EvidenceRef = {
    artifact_path: event.artifact_path,
    artifact_sha256: event.artifact_sha256,
    event_id: event.record.event_id,
  };
  const located = { partition: event.partition, examined: event.origin !== 'execution_scope', ref };
  return [
    ...origin.flatMap((kind) => occurrence(kind, event.record, { ...located, origin_event_id: event.record.event_id })),
    ...appearance.flatMap((kind) => occurrence(kind, event.record, located)),
  ];
}

// A rejected call creates its id only at the execution level (A-09): a trial-partition rejection
// follows the `provider_call_received` that created it.
function createsIdentities(event: IndexedEvent): boolean {
  return event.record.record_type !== 'provider_call_rejected' || event.partition === 'execution';
}

function occurrence(
  kind: IdentityKind,
  value: object,
  located: Omit<IdentityOccurrence, 'kind' | 'id' | 'paired_attempt'>,
): readonly IdentityOccurrence[] {
  const record = value as JsonValue;
  const id = ownString(record, kind);
  if (id === undefined) {
    return [];
  }
  const pairedAttempt = kind === 'provider_request_id' ? ownString(record, 'attempt_id') : undefined;
  return [{ kind, id, ...located, ...(pairedAttempt === undefined ? {} : { paired_attempt: pairedAttempt }) }];
}

function ledgerSnapshots(artifacts: readonly IngestedArtifact[]): readonly LocatedRecord<LedgerSnapshot>[] {
  return artifacts.flatMap((artifact) =>
    artifact.records
      .filter(
        (record) =>
          record.validity !== 'schema_invalid' && ownString(record.value, 'record_type') === 'ledger_snapshot',
      )
      .map((record) => locateRecord<LedgerSnapshot>(artifact, record)),
  );
}

function ledgerOccurrences(snapshot: LocatedRecord<LedgerSnapshot>): readonly IdentityOccurrence[] {
  const partition = partitionOf(snapshot.record as unknown as JsonValue);
  return snapshot.record.transactions.flatMap((transaction, index) => {
    const located = {
      partition,
      examined: snapshot.origin !== 'execution_scope',
      ledger_item: `${snapshot.artifact_path}#${String(index)}`,
      ref: {
        artifact_path: snapshot.artifact_path,
        artifact_sha256: snapshot.artifact_sha256,
        json_pointer: `/transactions/${String(index)}`,
      },
    };
    return LEDGER_KINDS.flatMap((kind) => occurrence(kind, transaction, located));
  });
}

function isJudgedCollision(group: readonly IdentityOccurrence[]): boolean {
  if (!group.some((entry) => entry.examined)) {
    return false;
  }
  const origins = new Set(
    group.flatMap((entry) => (entry.origin_event_id === undefined ? [] : [entry.origin_event_id])),
  );
  const partitions = new Set(group.map((entry) => entry.partition));
  const attempts = new Set(
    group.flatMap((entry) => (entry.paired_attempt === undefined ? [] : [entry.paired_attempt])),
  );
  // A transaction or commit id on two ledger items is a duplicate provider-generated identity
  // (INV-RUA-001), even within one partition and without any commit event.
  const items = new Set(
    group.flatMap((entry) =>
      entry.ledger_item === undefined || !COMMIT_KINDS.includes(entry.kind) ? [] : [entry.ledger_item],
    ),
  );
  return origins.size > 1 || partitions.size > 1 || attempts.size > 1 || items.size > 1;
}

function toCollision(group: readonly IdentityOccurrence[]): IdentityCollision {
  const [first] = group as readonly [IdentityOccurrence, ...IdentityOccurrence[]];
  const origins = group.flatMap((entry) => (entry.origin_event_id === undefined ? [] : [entry.origin_event_id]));
  return {
    kind: first.kind,
    id: first.id,
    origin_event_ids: [...new Set(origins)].toSorted(),
    partitions: [...new Set(group.map((entry) => entry.partition))].toSorted(),
    refs: sortEvidenceRefs(group.map((entry) => entry.ref)),
  };
}

// An attempt is registered when some `attempt_registered` created its id; where it was created is
// the collision check's concern.
function unregisteredAttempts(
  events: readonly IndexedEvent[],
  byIdentity: ReadonlyMap<string, readonly IdentityOccurrence[]>,
): IdentityRegistry['unregistered_attempts'] {
  const registered = (attemptId: string): boolean =>
    (byIdentity.get(`attempt_id#${attemptId}`) ?? []).some((entry) => entry.origin_event_id !== undefined);
  return events.flatMap((event) => {
    const attemptId = ownString(event.record as unknown as JsonValue, 'attempt_id');
    if (event.origin !== 'subject' || !referencesAttempt(event) || attemptId === undefined || registered(attemptId)) {
      return [];
    }
    return [
      {
        attempt_id: attemptId,
        ref: {
          artifact_path: event.artifact_path,
          artifact_sha256: event.artifact_sha256,
          event_id: event.record.event_id,
        },
      },
    ];
  });
}

// The runner's readiness canary records a `caller_timeout_recorded` of its own (D-10); only a
// caller's records reference a variant attempt.
function referencesAttempt(event: IndexedEvent): boolean {
  return ATTEMPT_REFERENCES.has(event.record.record_type) && event.record.source !== 'runner';
}

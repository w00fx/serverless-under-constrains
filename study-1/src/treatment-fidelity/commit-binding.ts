// How the targeted commit K binds to the rest of the evidence (BR-RUA-025, design §8.3 G4b). The
// transition to COMMITTED_WAITING atomically commits the ledger transaction, writes the provider
// event and consumes the treatment, so all three share one commit triple (`provider_commit_id`,
// `provider_transaction_id`, `provider_call_id`); a recorded difference invalidates fidelity. The
// first accepted provider call is the targeted one; another first call invalidates it. A ledger
// that is readable but lacks K's transaction, or no accepted call at all, leaves fidelity
// unverified: the binding cannot be shown.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { CommitTriple } from '../record-contract/records/group-b/shared-shapes.ts';
import { refOf } from './condition-result.ts';
import type { EventOf } from './subject-events.ts';
import type { TreatmentView } from './treatment-view.ts';

const SUBJECT = 'BR-RUA-025';
const TRIPLE_FIELDS = ['provider_commit_id', 'provider_transaction_id', 'provider_call_id'] as const;

/** One source's view of the commit triple; a source may record only part of it. */
type PartialTriple = Partial<CommitTriple>;

interface TripleSource {
  readonly name: string;
  readonly triple: PartialTriple;
  readonly ref: EvidenceRef | undefined;
}

/**
 * Causes from the commit triple: `invalid` when a source records a different id than K, and
 * `unverified` when a usable ledger lacks K's transaction.
 *
 * @example
 * commitTripleCauses(view); // [] when K, K′, the ledger and the snapshot agree
 */
export function commitTripleCauses(view: TreatmentView): readonly GateCause[] {
  const commit = view.commit;
  if (commit === undefined) {
    return [];
  }
  const sources = tripleSources(view, commit);
  const mismatched = sources.filter((source) =>
    TRIPLE_FIELDS.some((field) => differs(source.triple[field], commit.record[field])),
  );
  const causes: GateCause[] = mismatched.map((source) => {
    const detail = `${source.name} records commit triple ${JSON.stringify(source.triple)}; expected ${JSON.stringify(tripleOf(commit.record))} as provider_transaction_committed ${commit.record.event_id}`;
    return {
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'COMMIT_TRIPLE_MISMATCH', detail, source.ref),
      refs: refsOf(source.ref, refOf(commit)),
    };
  });
  const ledgerTransaction = view.ledger.transactions.find(
    (transaction) => transaction.provider_transaction_id === commit.record.provider_transaction_id,
  );
  if (view.ledger.status === 'present' && ledgerTransaction === undefined) {
    const detail = `the ledger holds no transaction ${commit.record.provider_transaction_id}; expected the targeted commit's transaction`;
    causes.push({
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'LEDGER_TRANSACTION_MISSING', detail, view.ledger_state.ref),
      refs: refsOf(view.ledger_state.ref, refOf(commit)),
    });
  }
  return causes;
}

/**
 * Causes from the first accepted provider call, ordered by occurrence time: `invalid` when it is
 * not K's call, `unverified` when no call was accepted.
 *
 * @example
 * firstAcceptedCallCauses(view); // [] when the first accepted call is the targeted one
 */
export function firstAcceptedCallCauses(view: TreatmentView): readonly GateCause[] {
  const first = earliest(view.accepted_calls);
  const commit = view.commit;
  if (first === undefined) {
    const detail = 'no provider_call_accepted in the partition; expected the targeted call to be the first accepted';
    const ref = view.journals.provider.ref;
    return [
      { value: 'unverified', reason: reasonAt(SUBJECT, 'ACCEPTED_CALL_MISSING', detail, ref), refs: refsOf(ref) },
    ];
  }
  if (commit === undefined || first.record.provider_call_id === commit.record.provider_call_id) {
    return [];
  }
  const detail = `the first accepted call is ${first.record.provider_call_id}; expected the targeted call ${commit.record.provider_call_id}`;
  return [
    {
      value: 'invalid',
      reason: reasonAt(SUBJECT, 'FIRST_ACCEPTED_CALL_UNTARGETED', detail, refOf(first)),
      refs: refsOf(refOf(first), refOf(commit)),
    },
  ];
}

function tripleSources(
  view: TreatmentView,
  commit: EventOf<'provider_transaction_committed'>,
): readonly TripleSource[] {
  const sources: TripleSource[] = [];
  const confirmation = view.confirmation;
  if (confirmation !== undefined) {
    sources.push({
      name: 'provider_commit_confirmed',
      triple: tripleOf(confirmation.record),
      ref: refOf(confirmation),
    });
  }
  const transaction = view.ledger.transactions.find(
    (candidate) => candidate.provider_transaction_id === commit.record.provider_transaction_id,
  );
  if (transaction !== undefined) {
    sources.push({ name: 'the ledger transaction', triple: tripleOf(transaction), ref: view.ledger_state.ref });
  }
  const snapshot = view.snapshot?.record;
  if (snapshot?.item_present === true) {
    sources.push({ name: 'the treatment item', triple: tripleOf(snapshot.treatment), ref: view.snapshot_state.ref });
  }
  return sources;
}

function tripleOf(source: PartialTriple): PartialTriple {
  return Object.fromEntries(
    TRIPLE_FIELDS.flatMap((field) => (source[field] === undefined ? [] : [[field, source[field]]])),
  );
}

function differs(recorded: string | undefined, expected: string): boolean {
  return recorded !== undefined && recorded !== expected;
}

// Provider calls of one partition may come from several provider instances, so their order is
// their wall-clock occurrence; equal instants keep journal order.
function earliest(calls: readonly EventOf<'provider_call_accepted'>[]): EventOf<'provider_call_accepted'> | undefined {
  return calls.reduce<EventOf<'provider_call_accepted'> | undefined>(
    (first, call) => (first === undefined || call.record.occurred_at < first.record.occurred_at ? call : first),
    undefined,
  );
}

function refsOf(...refs: readonly (EvidenceRef | undefined)[]): readonly EvidenceRef[] {
  return refs.filter((ref) => ref !== undefined);
}

// The step-5 safety release on the control table (BR-RUA-025, BR-RUA-048 step 5; design §9.3
// `control`, §10.4): a conditional update of one treatment item from a nonterminal state to
// `SAFETY_RELEASED` with cause `CLEANUP_REQUEST`.
//
// The update is conditioned on the state and version cleanup just read, so it never overwrites a
// transition the provider or controller made in between: a lost race re-reads and decides again.
// Releasing from `ARMED` too keeps a late provider call from committing after cleanup started
// (BR-RUA-048 step 3 "prevents new processing"); the treatment schema allows a release from ARMED.
//
// An ambiguous write is reported failed: the step fails, and a re-run reads the item again,
// finding it either released (`not_held`) or still waiting (released then).
//
// The item is untrusted store content (Owner amendment A-05): only its own `state` and `version`
// members are read, and an item whose state is not a BR-RUA-025 treatment state or whose version
// is not an integer >= 1 (the `treatment_item` contract) fails the release instead of passing as
// `not_held`, because nothing then proves that no barrier is held.

import { describeJson } from '../record-contract/json-value.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { NonterminalTreatmentState, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import { NONTERMINAL_TREATMENT_STATES, TREATMENT_STATES } from '../record-contract/records/group-b/vocabulary.ts';
import type { DurableItemStore, StoredItem, WriteAction, WriteOutcome } from '../durable-store/item-store-port.ts';
import type { BarrierReleaseOutcome, BarrierReleasePort } from './cleanup-ports.ts';

/** The control-table sort key of the treatment item (design §9.3). */
export const TREATMENT_ITEM_SORT_KEY = 'treatment';
/** Read-and-release attempts before a partition that keeps changing is reported failed. */
export const MAX_RELEASE_ATTEMPTS = 3;
const RELEASED_STATE = 'SAFETY_RELEASED';
const CLEANUP_CAUSE = 'CLEANUP_REQUEST';

type ReleaseDecision =
  | { readonly kind: 'release'; readonly from: NonterminalTreatmentState; readonly version: number }
  | { readonly kind: 'done'; readonly outcome: BarrierReleaseOutcome };

/**
 * Releases treatment barriers held in the control table, one partition at a time.
 *
 * @example
 * const barriers = new ControlTableBarrierRelease(store);
 * await barriers.requestSafetyRelease('3f1c…#trial#9a2b…'); // { kind: 'released', from_state: 'COMMITTED_WAITING' }
 */
export class ControlTableBarrierRelease implements BarrierReleasePort {
  readonly #store: DurableItemStore;

  constructor(store: DurableItemStore) {
    this.#store = store;
  }

  /** Moves the partition's treatment item to SAFETY_RELEASED when it is in a nonterminal state. */
  requestSafetyRelease(partitionKey: string): Promise<BarrierReleaseOutcome> {
    return this.#attemptRelease(partitionKey, 1);
  }

  // One read-and-release attempt; a lost race tries again, at most MAX_RELEASE_ATTEMPTS deep.
  async #attemptRelease(partitionKey: string, attempt: number): Promise<BarrierReleaseOutcome> {
    const decision = await this.#decide(partitionKey);
    if (decision.kind === 'done') {
      return decision.outcome;
    }
    const written = await this.#store.write(releaseAction(partitionKey, decision.from, decision.version));
    return (
      releaseOutcome(partitionKey, decision.from, written, attempt) ?? this.#attemptRelease(partitionKey, attempt + 1)
    );
  }

  async #decide(partitionKey: string): Promise<ReleaseDecision> {
    const read = await this.#store.getConsistent('control', { pk: partitionKey, sk: TREATMENT_ITEM_SORT_KEY });
    if (!read.ok) {
      return {
        kind: 'done',
        outcome: failed(partitionKey, `treatment read failed with ${read.error.code}; expected the item`),
      };
    }
    if (read.value === undefined) {
      return { kind: 'done', outcome: { kind: 'not_held' } };
    }
    return decideFromItem(partitionKey, read.value);
  }
}

// The outcome of one release write, or undefined when a concurrent transition won the race and
// the item must be read and decided again (at most MAX_RELEASE_ATTEMPTS times).
function releaseOutcome(
  partitionKey: string,
  from: NonterminalTreatmentState,
  written: WriteOutcome,
  attempt: number,
): BarrierReleaseOutcome | undefined {
  if (written.kind === 'applied') {
    return { kind: 'released', from_state: from };
  }
  if (written.kind !== 'condition_failed') {
    return failed(partitionKey, `release write ${describeOutcome(written)}; expected applied`);
  }
  if (attempt < MAX_RELEASE_ATTEMPTS) {
    return undefined;
  }
  return failed(
    partitionKey,
    `treatment item changed during ${String(MAX_RELEASE_ATTEMPTS)} release attempts (last ${describeOutcome(written)}); expected a stable state`,
  );
}

function decideFromItem(partitionKey: string, item: StoredItem): ReleaseDecision {
  const state = ownMember(item, 'state');
  const version = ownMember(item, 'version');
  if (!isTreatmentState(state) || !isTreatmentVersion(version)) {
    return {
      kind: 'done',
      outcome: failed(
        partitionKey,
        `treatment item state ${describeJson(state)} version ${describeJson(version)}; expected one of ${TREATMENT_STATES.join(', ')} and an integer version >= 1`,
      ),
    };
  }
  if (!isNonterminal(state)) {
    return { kind: 'done', outcome: { kind: 'not_held', state } };
  }
  return { kind: 'release', from: state, version };
}

// A member the item itself holds; an inherited name never counts (A-05).
function ownMember(item: StoredItem, name: string): JsonValue | undefined {
  return Object.hasOwn(item, name) ? item[name] : undefined;
}

function isTreatmentState(state: JsonValue | undefined): state is TreatmentState {
  return typeof state === 'string' && (TREATMENT_STATES as readonly string[]).includes(state);
}

// The `treatment_item` contract: an integer version >= 1 (a non-finite number is no integer).
function isTreatmentVersion(version: JsonValue | undefined): version is number {
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 1;
}

function releaseAction(partitionKey: string, from: NonterminalTreatmentState, version: number): WriteAction {
  return {
    kind: 'update',
    table: 'control',
    key: { pk: partitionKey, sk: TREATMENT_ITEM_SORT_KEY },
    set: { state: RELEASED_STATE, safety_release_cause: CLEANUP_CAUSE },
    increment: { version: 1 },
    condition: {
      kind: 'all',
      conditions: [
        { kind: 'attribute_equals', name: 'state', value: from },
        { kind: 'attribute_equals', name: 'version', value: version },
      ],
    },
  };
}

function isNonterminal(state: TreatmentState): state is NonterminalTreatmentState {
  return (NONTERMINAL_TREATMENT_STATES as readonly string[]).includes(state);
}

function describeOutcome(outcome: WriteOutcome): string {
  return outcome.kind === 'definitive_failure' || outcome.kind === 'ambiguous'
    ? `${outcome.kind} (${outcome.code})`
    : outcome.kind;
}

function failed(partitionKey: string, detail: string): BarrierReleaseOutcome {
  const reason: StructuredReason = { code: 'SAFETY_RELEASE_FAILED', subject: partitionKey, detail };
  return { kind: 'failed', reason };
}

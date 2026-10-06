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

import { describeJson } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { NonterminalTreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import { NONTERMINAL_TREATMENT_STATES } from '../record-contract/records/group-b/vocabulary.ts';
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
  async requestSafetyRelease(partitionKey: string): Promise<BarrierReleaseOutcome> {
    let lastOutcome = 'none';
    for (let attempt = 1; attempt <= MAX_RELEASE_ATTEMPTS; attempt += 1) {
      const decision = await this.#decide(partitionKey);
      if (decision.kind === 'done') {
        return decision.outcome;
      }
      const written = await this.#store.write(releaseAction(partitionKey, decision.from, decision.version));
      if (written.kind === 'applied') {
        return { kind: 'released', from_state: decision.from };
      }
      if (written.kind !== 'condition_failed') {
        return failed(partitionKey, `release write ${describeOutcome(written)}; expected applied`);
      }
      lastOutcome = describeOutcome(written);
    }
    return failed(
      partitionKey,
      `treatment item changed during ${String(MAX_RELEASE_ATTEMPTS)} release attempts (last ${lastOutcome}); expected a stable state`,
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

function decideFromItem(partitionKey: string, item: StoredItem): ReleaseDecision {
  const state = item['state'];
  const version = item['version'];
  if (typeof state !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return {
      kind: 'done',
      outcome: failed(
        partitionKey,
        `treatment item state ${describeJson(state)} version ${describeJson(version)}; expected a state string and an integer version`,
      ),
    };
  }
  if (!isNonterminal(state)) {
    return { kind: 'done', outcome: { kind: 'not_held', state } };
  }
  return { kind: 'release', from: state, version };
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

function isNonterminal(state: string): state is NonterminalTreatmentState {
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

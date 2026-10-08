// The step-5 safety release over the control table (BR-RUA-025, BR-RUA-048 step 5; design
// §9.3) with DynamoDB item semantics in memory: a nonterminal treatment moves to SAFETY_RELEASED
// with cause CLEANUP_REQUEST only under its read state and version, a concurrent transition is
// never overwritten, and every failure is a value.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ControlTableBarrierRelease,
  MAX_RELEASE_ATTEMPTS,
  TREATMENT_ITEM_SORT_KEY,
} from '../../../src/cleanup/control-barrier-release.ts';
import type { DurableItemStore, StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  NONTERMINAL_TREATMENT_STATES,
  TREATMENT_STATES,
} from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { InterleavingItemStore } from '../../support/cleanup/interleaving-item-store.ts';
import { VerbatimReadItemStore } from '../../support/cleanup/verbatim-read-item-store.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';

const PARTITION = 'aaaaaaaa-0000-4000-8000-000000000001#bbbbbbbb-0000-4000-8000-000000000001';
const KEY = { pk: PARTITION, sk: TREATMENT_ITEM_SORT_KEY };

function treatment(state: JsonValue, version: JsonValue = 3): StoredItem {
  return { ...KEY, state, version, provider_commit_id: 'commit-1' };
}

/** A concurrent writer moving a waiting treatment to `state`, as the provider or controller would. */
function transitionTo(state: string): (store: DurableItemStore) => Promise<void> {
  return async (store) => {
    const outcome = await store.write({
      kind: 'update',
      table: 'control',
      key: KEY,
      set: { state },
      increment: { version: 1 },
      condition: { kind: 'attribute_in', name: 'state', values: [...NONTERMINAL_TREATMENT_STATES] },
    });
    assert.equal(outcome.kind, 'applied');
  };
}

describe('ControlTableBarrierRelease', () => {
  for (const state of NONTERMINAL_TREATMENT_STATES) {
    it(`releases a treatment in ${state} with cause CLEANUP_REQUEST`, async () => {
      const { store } = storeHarness();
      store.seed('control', treatment(state));
      const outcome = await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION);
      assert.deepEqual(outcome, { kind: 'released', from_state: state });
      assert.deepEqual(store.peek('control', KEY), {
        ...KEY,
        state: 'SAFETY_RELEASED',
        safety_release_cause: 'CLEANUP_REQUEST',
        version: 4,
        provider_commit_id: 'commit-1',
      });
    });
  }

  it('leaves a terminal treatment alone', async () => {
    for (const state of ['RESPONSE_RELEASED', 'SAFETY_RELEASED']) {
      const { store } = storeHarness();
      store.seed('control', treatment(state));
      assert.deepEqual(await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION), {
        kind: 'not_held',
        state,
      });
      assert.deepEqual(store.peek('control', KEY), treatment(state));
    }
  });

  it('reports a partition without a treatment item as not held', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION), { kind: 'not_held' });
    assert.equal(store.peek('control', KEY), undefined);
  });

  it('refuses a malformed treatment item without writing', async () => {
    const malformed: readonly (readonly [JsonValue, JsonValue | undefined, RegExp])[] = [
      [7, 3, /state number 7 version number 3/],
      ['ARMED', '3', /version string "3"/],
      ['ARMED', 1.5, /version number 1.5/],
      ['ARMED', undefined, /version absent/],
    ];
    for (const [state, version, detail] of malformed) {
      const { store } = storeHarness();
      const item: StoredItem = version === undefined ? { ...KEY, state } : { ...KEY, state, version };
      store.seed('control', item);
      const outcome = await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION);
      assert.equal(outcome.kind, 'failed');
      assert.equal(outcome.reason.code, 'SAFETY_RELEASE_FAILED');
      assert.match(outcome.reason.detail, detail);
      assert.deepEqual(store.peek('control', KEY), item);
    }
  });

  it('refuses a treatment state outside BR-RUA-025 instead of reporting it not held', async () => {
    // Regression (WP-19 review): an unknown state used to pass as `not_held`, so step 5 reported
    // success while nothing proved the barrier was released.
    for (const state of ['RELEASED', 'armed', 'constructor', 'toString', '__proto__', '']) {
      const { store } = storeHarness();
      store.seed('control', treatment(state));
      const outcome = await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION);
      assert.equal(outcome.kind, 'failed', state);
      assert.equal(outcome.reason.subject, PARTITION);
      assert.equal(
        outcome.reason.detail,
        `treatment item state string ${JSON.stringify(state)} version number 3; expected one of ${TREATMENT_STATES.join(', ')} and an integer version >= 1`,
      );
      assert.deepEqual(store.peek('control', KEY), treatment(state));
    }
  });

  it('refuses a version below 1 or not finite, as the treatment_item contract requires', async () => {
    const versions: readonly (readonly [number, string])[] = [
      [0, 'number 0'],
      [-1, 'number -1'],
      [Number.POSITIVE_INFINITY, 'number Infinity'],
      [Number.NaN, 'number NaN'],
      [2 ** 53, `number ${String(2 ** 53)}`],
    ];
    for (const [version, described] of versions) {
      const hostile = new VerbatimReadItemStore(storeHarness().store, treatment('COMMITTED_WAITING', version));
      const outcome = await new ControlTableBarrierRelease(hostile).requestSafetyRelease(PARTITION);
      assert.equal(outcome.kind, 'failed', described);
      assert.ok(outcome.reason.detail.includes(`version ${described};`), outcome.reason.detail);
      assert.equal(hostile.writeCount(), 0);
    }
    const { store } = storeHarness();
    store.seed('control', treatment('ARMED', 1));
    assert.deepEqual(await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION), {
      kind: 'released',
      from_state: 'ARMED',
    });
  });

  it('fails as a value when the store refuses to increment the largest safe version', async () => {
    // Promoted from the fuzz counterexample ["ARMED", 9007199254740991] (seed 2135275739, WP-19
    // review): the version is valid, but its increment is not a number the store carries exactly.
    const { store } = storeHarness();
    store.seed('control', treatment('ARMED', Number.MAX_SAFE_INTEGER));
    const outcome = await new ControlTableBarrierRelease(store).requestSafetyRelease(PARTITION);
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.reason.detail, /^release write definitive_failure \(\w+\); expected applied$/);
    assert.deepEqual(store.peek('control', KEY), treatment('ARMED', Number.MAX_SAFE_INTEGER));
  });

  it('reads only the members the item itself holds (A-05 inherited names)', async () => {
    const inherited = Object.create({ state: 'COMMITTED_WAITING', version: 3 }) as Record<string, JsonValue>;
    inherited['pk'] = PARTITION;
    inherited['sk'] = TREATMENT_ITEM_SORT_KEY;
    const hostile = new VerbatimReadItemStore(storeHarness().store, inherited as StoredItem);
    const outcome = await new ControlTableBarrierRelease(hostile).requestSafetyRelease(PARTITION);
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.reason.detail, /^treatment item state absent version absent;/);
    assert.equal(hostile.writeCount(), 0);
  });

  it('refuses a state nested 100,000 levels deep with a bounded detail (A-05)', async () => {
    let nested: JsonValue = 'ARMED';
    for (let level = 0; level < 100_000; level += 1) {
      nested = level % 2 === 0 ? [nested] : { state: nested };
    }
    const hostile = new VerbatimReadItemStore(storeHarness().store, treatment(nested));
    const outcome = await new ControlTableBarrierRelease(hostile).requestSafetyRelease(PARTITION);
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.reason.detail, /^treatment item state object \{"state":\[\{"state":\[/);
    assert.ok(outcome.reason.detail.length < 500, `detail of ${String(outcome.reason.detail.length)} characters`);
    assert.equal(hostile.writeCount(), 0);
  });

  it('reports read and write failures as values', async () => {
    const reading = storeHarness();
    reading.store.scriptReadFault('InternalServerError');
    const readFailure = await new ControlTableBarrierRelease(reading.store).requestSafetyRelease(PARTITION);
    assert.match(JSON.stringify(readFailure), /treatment read failed with InternalServerError; expected the item/);

    const definitive = storeHarness();
    definitive.store.seed('control', treatment('COMMITTED_WAITING'));
    definitive.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ValidationException' });
    const refused = await new ControlTableBarrierRelease(definitive.store).requestSafetyRelease(PARTITION);
    assert.match(JSON.stringify(refused), /release write definitive_failure \(ValidationException\); expected applied/);

    const ambiguous = storeHarness();
    ambiguous.store.seed('control', treatment('COMMITTED_WAITING'));
    ambiguous.store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: true });
    const unknown = await new ControlTableBarrierRelease(ambiguous.store).requestSafetyRelease(PARTITION);
    assert.match(JSON.stringify(unknown), /release write ambiguous \(TimeoutError\)/);
    const rerun = await new ControlTableBarrierRelease(ambiguous.store).requestSafetyRelease(PARTITION);
    assert.deepEqual(rerun, { kind: 'not_held', state: 'SAFETY_RELEASED' }, 'a re-run finds the applied release');
  });

  it('decides again after a concurrent transition instead of overwriting it', async () => {
    const { store } = storeHarness();
    store.seed('control', treatment('COMMITTED_WAITING'));
    const racing = new InterleavingItemStore(store);
    racing.afterRead(1, transitionTo('TIMEOUT_SIGNALLED'));
    assert.deepEqual(await new ControlTableBarrierRelease(racing).requestSafetyRelease(PARTITION), {
      kind: 'released',
      from_state: 'TIMEOUT_SIGNALLED',
    });
    assert.equal(store.peek('control', KEY)?.['version'], 5);

    const settled = storeHarness();
    settled.store.seed('control', treatment('TIMEOUT_OBSERVED'));
    const racingToRelease = new InterleavingItemStore(settled.store);
    racingToRelease.afterRead(1, transitionTo('RESPONSE_RELEASED'));
    assert.deepEqual(await new ControlTableBarrierRelease(racingToRelease).requestSafetyRelease(PARTITION), {
      kind: 'not_held',
      state: 'RESPONSE_RELEASED',
    });
    assert.equal(settled.store.peek('control', KEY)?.['state'], 'RESPONSE_RELEASED');
  });

  it('gives up on a treatment that changes on every attempt', async () => {
    const { store } = storeHarness();
    store.seed('control', treatment('ARMED'));
    const racing = new InterleavingItemStore(store);
    for (let read = 1; read <= MAX_RELEASE_ATTEMPTS; read += 1) {
      racing.afterRead(read, transitionTo('ARMED'));
    }
    const outcome = await new ControlTableBarrierRelease(racing).requestSafetyRelease(PARTITION);
    assert.match(
      JSON.stringify(outcome),
      /changed during 3 release attempts \(last condition_failed\); expected a stable state/,
    );
    assert.equal(racing.readCount(), MAX_RELEASE_ATTEMPTS);
    assert.equal(store.peek('control', KEY)?.['state'], 'ARMED');
  });
});

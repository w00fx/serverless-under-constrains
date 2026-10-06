// Property-based tests of the stored request-state and attempt-state readers (testing rule 6):
// both read items back from DynamoDB, so they are untrusted until checked. A written snapshot
// always reads back unchanged; any attribute replaced by an arbitrary value is either still a
// valid snapshot or is refused with a bounded message; and the orphan search is total over
// damaged partitions, values nested far deeper than the call stack and non-finite numbers
// (Owner amendment A-05). Orphans are only ever unaccounted attempts of the request.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { findOrphanAttempts } from '../../../src/conventional-variant/request-state/orphan-attempts.ts';
import {
  parseRequestStateItem,
  toRequestStateItem,
} from '../../../src/conventional-variant/request-state/request-state-item.ts';
import type { RequestStateSnapshot } from '../../../src/conventional-variant/request-state/request-state-item.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { EFFECT_KNOWLEDGE_STATES, PROCESSING_STATES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { REFUND_REQUEST_ID, TRIAL_PK } from '../../unit/trial-message/support/trial-message-fixtures.ts';

const KEY = { pk: TRIAL_PK, sk: `state#request#${REFUND_REQUEST_ID}` };
const ITEM_ATTRIBUTES = ['version', 'effect_knowledge', 'attempt_ids', 'processing_state', 'extra'] as const;

const hostileValue: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>, weight: 8 },
  { arbitrary: deepTowerArbitrary(), weight: 1 },
  { arbitrary: fc.constantFrom<JsonValue>(Number.POSITIVE_INFINITY, Number.NaN, 0, 1.5, 2 ** 53), weight: 1 },
);

const attemptId: fc.Arbitrary<Uuid4> = fc.uuid({ version: 4 }).map((id) => id as Uuid4);

const snapshot: fc.Arbitrary<RequestStateSnapshot> = fc.record(
  {
    version: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    effect_knowledge: fc.constantFrom(...EFFECT_KNOWLEDGE_STATES),
    attempt_ids: fc.uniqueArray(attemptId, { maxLength: 4 }),
    processing_state: fc.constantFrom(...PROCESSING_STATES),
  },
  { noNullPrototype: true },
);

function attemptItem(id: JsonValue, refund: JsonValue, phase: JsonValue): StoredItem {
  return {
    pk: TRIAL_PK,
    sk: `state#attempt#${typeof id === 'string' ? id : 'x'}`,
    attempt_id: id,
    refund_request_id: refund,
    phase,
  };
}

describe('request-state item properties', () => {
  it('reads every written snapshot back unchanged', () => {
    fc.assert(
      fc.property(snapshot, (written) => {
        assert.deepEqual(parseRequestStateItem(toRequestStateItem(KEY, written)), { ok: true, value: written });
      }),
      fuzzParameters(),
    );
  });

  it('refuses or keeps a snapshot whose attribute was replaced, never throwing', () => {
    fc.assert(
      fc.property(snapshot, fc.constantFrom(...ITEM_ATTRIBUTES), hostileValue, (written, attribute, value) => {
        const item: StoredItem = { ...toRequestStateItem(KEY, written), [attribute]: value };
        const parsed = parseRequestStateItem(item);
        if (!parsed.ok) {
          assert.ok(parsed.error.startsWith(`request-state item ${KEY.sk} `), parsed.error.slice(0, 200));
          assert.ok(parsed.error.length < 2_000 && parsed.error.includes('expected'), parsed.error.slice(0, 200));
          return;
        }
        assert.notEqual(attribute, 'extra');
        assert.deepEqual(parsed.value, { ...written, [attribute]: value });
      }),
      fuzzParameters(),
    );
  });
});

describe('findOrphanAttempts properties', () => {
  it('returns only unaccounted attempts of the request, or a bounded failure for a damaged item', () => {
    const itemArbitrary = fc.record({
      id: fc.oneof(attemptId as fc.Arbitrary<JsonValue>, hostileValue),
      refund: fc.oneof(fc.constantFrom<JsonValue>(REFUND_REQUEST_ID, 'ref-other'), hostileValue),
      phase: fc.oneof(fc.constantFrom<JsonValue>('PRE_DISPATCH', 'NOT_DISPATCHED', 'DISPATCHED'), hostileValue),
    });
    const outcomeArbitrary = fc.record({
      id: fc.oneof(attemptId as fc.Arbitrary<JsonValue>, hostileValue),
      outcome: fc.oneof(fc.constantFrom<JsonValue>('SUCCEEDED', 'REJECTED', 'FAILED', 'TIMED_OUT'), hostileValue),
      dispatch: fc.oneof(fc.constantFrom<JsonValue>('DISPATCHED', 'NOT_DISPATCHED', 'UNKNOWN'), hostileValue),
    });
    fc.assert(
      fc.property(
        fc.array(itemArbitrary, { maxLength: 4 }),
        fc.array(outcomeArbitrary, { maxLength: 3 }),
        fc.uniqueArray(attemptId, { maxLength: 2 }),
        (attempts, outcomes, accounted) => {
          const items: StoredItem[] = [
            ...attempts.map((entry) => attemptItem(entry.id, entry.refund, entry.phase)),
            ...outcomes.map((entry, index) => ({
              pk: TRIAL_PK,
              sk: `conventional_caller#c#${String(index)}`,
              record_type: 'attempt_outcome_recorded',
              attempt_id: entry.id,
              outcome: entry.outcome,
              dispatch_state: entry.dispatch,
            })),
          ];
          const found = findOrphanAttempts(items, REFUND_REQUEST_ID, new Set(accounted));
          if (!found.ok) {
            assert.ok(found.error.length < 2_000 && found.error.includes('; expected'), found.error.slice(0, 200));
            return;
          }
          for (const orphan of found.value) {
            assert.ok(!accounted.includes(orphan.attempt_id));
            assert.ok(attempts.some((entry) => entry.id === orphan.attempt_id && entry.refund === REFUND_REQUEST_ID));
          }
        },
      ),
      fuzzParameters(),
    );
  });
});

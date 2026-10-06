// The request-state item of the caller journal (design §9.3): its keys, its stored form, and the
// check that stops a recording on a damaged item instead of extending a wrong history.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REJECTED_MESSAGE_STATE_SK_PREFIX,
  REQUEST_STATE_SK_PREFIX,
  isOneOf,
  parseRequestStateItem,
  rejectedMessageStateKey,
  requestStateKey,
  toRequestStateItem,
} from '../../../src/conventional-variant/request-state/request-state-item.ts';
import type { RequestStateSnapshot } from '../../../src/conventional-variant/request-state/request-state-item.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { PROCESSING_STATES } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';
import { TRIAL_PK } from '../trial-message/support/trial-message-fixtures.ts';

const ATTEMPT_A = 'dddddddd-0000-4000-8000-00000000000a' as Uuid4;
const ATTEMPT_B = 'dddddddd-0000-4000-8000-00000000000b' as Uuid4;
const KEY = { pk: TRIAL_PK, sk: 'state#request#ref-poc-001' };
const SNAPSHOT: RequestStateSnapshot = {
  version: 2,
  effect_knowledge: 'UNKNOWN',
  attempt_ids: [ATTEMPT_A, ATTEMPT_B],
  processing_state: 'RUNNING',
};

function storedItem(overrides: Readonly<Record<string, JsonValue>> = {}): StoredItem {
  return { ...toRequestStateItem(KEY, SNAPSHOT), ...overrides };
}

function refusal(item: StoredItem): string {
  const parsed = parseRequestStateItem(item);
  assert.equal(parsed.ok, false);
  return parsed.error;
}

describe('request-state keys', () => {
  it('key a request by its refund request id and an unidentified rejection by its message id', () => {
    assert.equal(REQUEST_STATE_SK_PREFIX, 'state#request#');
    assert.equal(REJECTED_MESSAGE_STATE_SK_PREFIX, 'state#rejected-message#');
    assert.deepEqual(requestStateKey(TRIAL_PK, { refund_request_id: 'ref-poc-001' }), KEY);
    assert.deepEqual(rejectedMessageStateKey(TRIAL_PK, 'msg-1'), { pk: TRIAL_PK, sk: 'state#rejected-message#msg-1' });
  });
});

describe('toRequestStateItem and parseRequestStateItem', () => {
  it('store a snapshot under its key and read it back unchanged', () => {
    assert.deepEqual(toRequestStateItem(KEY, SNAPSHOT), { ...KEY, ...SNAPSHOT });
    assert.deepEqual(parseRequestStateItem(storedItem()), { ok: true, value: SNAPSHOT });
    const empty = { ...SNAPSHOT, version: 1, attempt_ids: [], effect_knowledge: 'NOT_ATTEMPTED' } as const;
    assert.deepEqual(parseRequestStateItem(toRequestStateItem(KEY, empty)), { ok: true, value: empty });
  });

  it('refuse an item with an unexpected attribute', () => {
    assert.match(
      refusal(storedItem({ refund_request_id: 'ref-poc-001' })),
      /unexpected attribute string "refund_request_id"/,
    );
  });

  it('refuse each malformed attribute, naming it', () => {
    const cases: readonly (readonly [Readonly<Record<string, JsonValue>>, RegExp])[] = [
      [{ version: 0 }, /version number 0; expected a positive safe integer$/],
      [{ version: 1.5 }, /version number 1.5; expected a positive safe integer$/],
      [{ version: '2' }, /version string "2"; expected a positive safe integer$/],
      [{ effect_knowledge: 'MAYBE' }, /effect_knowledge string "MAYBE"; expected one of NOT_ATTEMPTED, /],
      [{ processing_state: 'DONE' }, /processing_state string "DONE"; expected one of NOT_STARTED, RUNNING, FINISHED$/],
      [{ attempt_ids: [ATTEMPT_A, ATTEMPT_A] }, /attempt_ids array .*; expected unique lowercase UUIDv4 values$/],
      [{ attempt_ids: ['x'] }, /attempt_ids array \["x"\]; expected unique/],
      [{ attempt_ids: 'x' }, /attempt_ids string "x"; expected unique/],
    ];
    for (const [overrides, pattern] of cases) {
      assert.match(refusal(storedItem(overrides)), pattern);
    }
  });

  it(`stay total on attributes nested ${String(DEEP_NESTING)} levels deep and on non-finite numbers`, () => {
    assert.ok(refusal(storedItem({ attempt_ids: parsedTower('array') })).length < 1_000);
    assert.match(refusal(storedItem({ version: Number.POSITIVE_INFINITY })), /version number Infinity/);
  });
});

describe('isOneOf', () => {
  it('accepts members of a closed vocabulary only', () => {
    assert.equal(isOneOf(PROCESSING_STATES, 'RUNNING'), true);
    assert.equal(isOneOf(PROCESSING_STATES, 'running'), false);
    assert.equal(isOneOf(PROCESSING_STATES, undefined), false);
  });
});

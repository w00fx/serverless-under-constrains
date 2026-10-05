// The closed record-type catalogue (design §6.2, addendum §2/§3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_RECORD_TYPES,
  RECORD_GROUPS,
  RECORD_TYPE_GROUPS,
  RECORD_TYPES,
  isEventRecordType,
  isRecordType,
  recordGroupOf,
} from '../../../src/record-contract/record-types.ts';
import type { RecordType } from '../../../src/record-contract/record-types.ts';

describe('record type catalogue', () => {
  it('lists 90 unique snake_case names: 18 in group A, 49 in group B, 23 in group C', () => {
    assert.deepEqual(RECORD_GROUPS, ['group-a', 'group-b', 'group-c']);
    assert.deepEqual(
      RECORD_GROUPS.map((group) => RECORD_TYPE_GROUPS[group].length),
      [18, 49, 23],
    );
    assert.equal(RECORD_TYPES.length, 90);
    assert.equal(new Set(RECORD_TYPES).size, 90);
    assert.deepEqual(
      RECORD_TYPES.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name)),
      [],
    );
    assert.deepEqual(RECORD_TYPES, [
      ...RECORD_TYPE_GROUPS['group-a'],
      ...RECORD_TYPE_GROUPS['group-b'],
      ...RECORD_TYPE_GROUPS['group-c'],
    ]);
  });

  it('places the provider warm-up records in group B, with only the completion as an event', () => {
    assert.equal(recordGroupOf('provider_warmup_request'), 'group-b');
    assert.equal(recordGroupOf('provider_warmup_completed'), 'group-b');
    assert.equal(isEventRecordType('provider_warmup_completed'), true);
    assert.equal(isEventRecordType('provider_warmup_request'), false);
  });

  it('marks 39 journal events, all in group B, and nothing else', () => {
    assert.equal(EVENT_RECORD_TYPES.length, 39);
    assert.equal(new Set(EVENT_RECORD_TYPES).size, 39);
    assert.deepEqual(
      EVENT_RECORD_TYPES.filter((name) => recordGroupOf(name) !== 'group-b'),
      [],
    );
    assert.deepEqual(RECORD_TYPES.filter(isEventRecordType), [...EVENT_RECORD_TYPES]);
    for (const snapshot of ['ledger_snapshot', 'queue_observation', 'payment', 'oracle_result'] as const) {
      assert.equal(isEventRecordType(snapshot), false, snapshot);
    }
  });

  it('recognizes exactly the catalogued names', () => {
    assert.equal(isRecordType('payment'), true);
    assert.equal(isRecordType('cli_result'), true);
    for (const value of ['Payment', 'payment ', '', 'refund', 1, null, undefined, ['payment']]) {
      assert.equal(isRecordType(value), false, String(value));
    }
  });

  it('maps every record type to its owning group and refuses an uncatalogued one', () => {
    assert.equal(recordGroupOf('environment_input'), 'group-a');
    assert.equal(recordGroupOf('trial_registration'), 'group-a');
    assert.equal(recordGroupOf('caller_invocation_started'), 'group-b');
    assert.equal(recordGroupOf('oracle_result'), 'group-c');
    assert.equal(recordGroupOf('cli_result'), 'group-c');
    assert.throws(
      () => recordGroupOf('refund' as RecordType),
      /record type "refund" is in no catalogue group; expected one of RECORD_TYPES/,
    );
  });
});

describe('record interfaces barrel', () => {
  it('is type-only: it loads under type stripping and exports no runtime value', async () => {
    const barrel: Readonly<Record<string, unknown>> = await import('../../../src/record-contract/records/index.ts');
    assert.deepEqual(Object.keys(barrel), []);
  });
});
